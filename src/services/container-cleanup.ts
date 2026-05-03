/**
 * Container Cleanup Service
 *
 * Mirrors the health monitor pattern — runs on boot and on a schedule,
 * deletes all stale Azure containers in parallel, syncs the DB, and logs
 * a full report each cycle.
 *
 * What counts as stale:
 *  - containerState is stopped / succeeded / failed  (Azure side is already done)
 *  - container is older than MAX_AGE_HOURS           (prevents quota exhaustion)
 *
 * Schedule: every 6 hours (configurable via CONTAINER_CLEANUP_INTERVAL_MS)
 * Max age:  24 hours      (configurable via CONTAINER_MAX_AGE_HOURS)
 *
 * After deleting a container, the matching session row is updated:
 *  containerId = null, containerUrl = null, containerStatus = 'cleaned'
 * so the DB stays in sync with Azure reality.
 */

import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { listAllContainerGroups } from './azure-provisioner';
import { ContainerInstanceManagementClient } from '@azure/arm-containerinstance';
import { DefaultAzureCredential, ClientSecretCredential } from '@azure/identity';

// ── Config ───────────────────────────────────────────────────────────────────

const SUBSCRIPTION_ID  = process.env.AZURE_SUBSCRIPTION_ID  || '';
const RESOURCE_GROUP   = process.env.AZURE_RESOURCE_GROUP   || 'promora-containers';
const INTERVAL_MS      = parseInt(process.env.CONTAINER_CLEANUP_INTERVAL_MS ?? '21600000', 10); // 6 h
const MAX_AGE_HOURS    = parseInt(process.env.CONTAINER_MAX_AGE_HOURS        ?? '24',       10);
// Delay before first boot scan so the server finishes initialising
const BOOT_DELAY_MS    = parseInt(process.env.CONTAINER_CLEANUP_BOOT_DELAY_MS ?? '300000',  10); // 5 min

let cleanupTimer: NodeJS.Timeout | null = null;

// ── Azure client helper ───────────────────────────────────────────────────────

function getAzureClient(): ContainerInstanceManagementClient {
  const tenantId     = process.env.AZURE_TENANT_ID;
  const clientId     = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  const credential = (tenantId && clientId && clientSecret)
    ? new ClientSecretCredential(tenantId, clientId, clientSecret)
    : new DefaultAzureCredential();

  return new ContainerInstanceManagementClient(credential, SUBSCRIPTION_ID);
}

// ── Single-container delete job ───────────────────────────────────────────────

interface DeleteResult {
  containerName: string;
  status: 'deleted' | 'failed';
  error?: string;
}

async function deleteContainer(
  client: ContainerInstanceManagementClient,
  containerName: string
): Promise<DeleteResult> {
  try {
    await client.containerGroups.beginDeleteAndWait(RESOURCE_GROUP, containerName);
    logger.info(`[ContainerCleanup] ✅ Deleted: ${containerName}`);
    return { containerName, status: 'deleted' };
  } catch (err: any) {
    logger.error(`[ContainerCleanup] ❌ Failed to delete ${containerName}: ${err.message}`);
    return { containerName, status: 'failed', error: err.message };
  }
}

// ── DB sync ───────────────────────────────────────────────────────────────────

/**
 * After deleting containers, clear the URL/ID from matching session rows
 * so the DB stays in sync with Azure reality.
 */
async function syncDeletedContainersToDb(deletedNames: string[]): Promise<void> {
  if (deletedNames.length === 0) return;

  try {
    // Session codes map 1:1 to container names (we use sessionCode as the Azure container name)
    const updated = await (prisma.session as any).updateMany({
      where: {
        sessionCode: { in: deletedNames },
      },
      data: {
        containerId:     null,
        containerUrl:    null,
        containerStatus: 'cleaned',
      },
    });
    if (updated.count > 0) {
      logger.info(`[ContainerCleanup] DB synced — cleared ${updated.count} session container references`);
    }
  } catch (err: any) {
    logger.warn(`[ContainerCleanup] DB sync failed: ${err.message}`);
  }
}

// ── Core scan ─────────────────────────────────────────────────────────────────

async function runCleanupScan(): Promise<void> {
  if (!SUBSCRIPTION_ID) {
    logger.warn('[ContainerCleanup] Skipped — AZURE_SUBSCRIPTION_ID not set');
    return;
  }

  const scanStart = Date.now();
  logger.info('[ContainerCleanup] 🔍 Scanning for stale containers...');

  // ── 1. Fetch all Azure container groups ──────────────────────────────────
  let allContainers: Awaited<ReturnType<typeof listAllContainerGroups>>;
  try {
    allContainers = await listAllContainerGroups();
  } catch (err: any) {
    logger.error(`[ContainerCleanup] Failed to list containers: ${err.message}`);
    return;
  }

  // ── 2. Decide what to delete ──────────────────────────────────────────────
  const now    = new Date();
  const maxAge = MAX_AGE_HOURS * 60 * 60 * 1000;

  const stale = allContainers.filter(c => {
    const terminalState = ['stopped', 'succeeded', 'failed'].includes(
      c.state?.toLowerCase() ?? ''
    );
    const tooOld = c.createdAt
      ? now.getTime() - c.createdAt.getTime() > maxAge
      : false;
    return terminalState || tooOld;
  });

  if (stale.length === 0) {
    logger.info(
      `[ContainerCleanup] ✅ No stale containers found (${allContainers.length} total, ${Date.now() - scanStart}ms)`
    );
    return;
  }

  logger.info(
    `[ContainerCleanup] Found ${stale.length} stale container(s) out of ${allContainers.length} — deleting in parallel`
  );

  // ── 3. Delete all stale containers in parallel ────────────────────────────
  // Same pattern as the health monitor: Promise.allSettled fires every job
  // simultaneously. Time = slowest single delete, not sum of all deletes.
  const client = getAzureClient();

  const results = await Promise.allSettled(
    stale.map(c => deleteContainer(client, c.name))
  );

  // ── 4. Tally + DB sync ────────────────────────────────────────────────────
  let deleted   = 0;
  let failed    = 0;
  const deletedNames: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.status === 'deleted') {
        deleted++;
        deletedNames.push(result.value.containerName);
      } else {
        failed++;
      }
    } else {
      failed++;
      logger.error(`[ContainerCleanup] Unexpected error: ${result.reason}`);
    }
  }

  // Clear container references from matching session rows
  await syncDeletedContainersToDb(deletedNames);

  const elapsed = Date.now() - scanStart;
  logger.info(
    `[ContainerCleanup] Done in ${elapsed}ms — ` +
    `deleted: ${deleted}, failed: ${failed}, total scanned: ${allContainers.length}`
  );
}

// ── Service lifecycle ─────────────────────────────────────────────────────────

/**
 * Start the cleanup service.
 * Runs a first scan after BOOT_DELAY_MS (server init grace period),
 * then on the configured interval. Safe to call multiple times.
 */
export function startContainerCleanup(): void {
  if (cleanupTimer) return;

  if (!SUBSCRIPTION_ID) {
    logger.info('[ContainerCleanup] Skipped — AZURE_SUBSCRIPTION_ID not set (local mode)');
    return;
  }

  logger.info(
    `[ContainerCleanup] Starting — interval: ${INTERVAL_MS / 3_600_000}h, ` +
    `max age: ${MAX_AGE_HOURS}h, boot delay: ${BOOT_DELAY_MS / 60_000}min`
  );

  // First scan after boot delay (give server time to fully initialise)
  setTimeout(() => {
    runCleanupScan().catch(err =>
      logger.error(`[ContainerCleanup] Boot scan error: ${err.message}`)
    );
  }, BOOT_DELAY_MS);

  // Then on the fixed interval
  cleanupTimer = setInterval(() => {
    runCleanupScan().catch(err =>
      logger.error(`[ContainerCleanup] Scheduled scan error: ${err.message}`)
    );
  }, INTERVAL_MS);

  if (cleanupTimer.unref) cleanupTimer.unref();
}

/**
 * Stop the cleanup service (tests / graceful shutdown).
 */
export function stopContainerCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    logger.info('[ContainerCleanup] Stopped');
  }
}

/**
 * Trigger an immediate out-of-schedule cleanup (e.g. admin endpoint).
 */
export async function triggerCleanupScan(): Promise<void> {
  await runCleanupScan();
}
