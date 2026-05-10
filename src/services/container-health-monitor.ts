/**
 * Container Health Monitor
 *
 * An autonomous agent that runs on a schedule and repairs sessions whose
 * on-demand provisioning failed or got stuck.
 *
 * Context: Containers are now provisioned on-demand when the candidate clicks
 * "Start Assessment" (NOT at invite time). The health monitor is only responsible
 * for cleaning up after failed/stuck on-demand provisioning attempts — it must
 * NEVER pre-provision containers for sessions that are simply waiting for the
 * candidate to arrive (containerStatus = 'pending').
 *
 * Schedule: every hour by default (configurable via CONTAINER_HEALTH_INTERVAL_MS)
 *
 * What it does each cycle:
 *  1. Find sessions with containerStatus = 'failed' (provisioning explicitly failed).
 *  2. Find sessions stuck in containerStatus = 'provisioning' for > 10 minutes
 *     (candidate clicked Start but the backend crashed mid-way).
 *  3. Load each session's template fileStructure and retry provisioning.
 *  4. Fire ALL repair jobs in parallel (Promise.allSettled).
 *  5. Log a human-readable report of fixed vs still-failed.
 */

import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { provisionLocalContainer } from './local-docker-provisioner';
import { provisionAssessmentContainer } from './azure-provisioner';

const getUseLocalDocker = () => process.env.USE_LOCAL_DOCKER === 'true';

// How often the monitor runs (default: every hour)
const INTERVAL_MS = parseInt(process.env.CONTAINER_HEALTH_INTERVAL_MS ?? '3600000', 10);

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10_000; // 10s between retries within a single job

let monitorTimer: NodeJS.Timeout | null = null;

// ── Single-session repair job (runs in parallel with other jobs) ─────────────

interface RepairResult {
  sessionCode: string;
  status: 'fixed' | 'skipped' | 'failed';
  url?: string;
  error?: string;
}

async function repairSession(session: {
  id: string;
  sessionCode: string;
  assignedVariantId: string;
  containerStatus: string | null;
}): Promise<RepairResult> {
  const { id: sessionId, sessionCode, assignedVariantId: templateId } = session;

  // Load the template file structure
  const tpl = await (prisma.template as any).findUnique({
    where: { id: templateId },
    select: { templateSpec: true },
  });

  const fileStructure = (tpl?.templateSpec as any)?.fileStructure as
    | Record<string, string>
    | undefined;

  // No fileStructure = no container needed — mark ready immediately
  if (!fileStructure || Object.keys(fileStructure).length === 0) {
    await (prisma.session as any).update({
      where: { id: sessionId },
      data: { containerStatus: 'ready' },
    });
    logger.info(`[HealthMonitor] ✅ ${sessionCode} — no fileStructure, marked ready`);
    return { sessionCode, status: 'skipped' };
  }

  // Retry loop — each job retries independently, no blocking other jobs
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(
        `[HealthMonitor] ${sessionCode} — attempt ${attempt}/${MAX_RETRIES}`
      );

      const result = getUseLocalDocker()
        ? await provisionLocalContainer(sessionCode, fileStructure)
        : await provisionAssessmentContainer(sessionCode, fileStructure);

      const r = result as any;

      await (prisma.session as any).update({
        where: { id: sessionId },
        data: {
          containerId:     r.containerId,
          containerUrl:    r.codeServerUrl,
          containerStatus: 'ready',
        },
      });

      logger.info(`[HealthMonitor] ✅ ${sessionCode} — repaired → ${r.codeServerUrl}`);
      return { sessionCode, status: 'fixed', url: r.codeServerUrl };
    } catch (err: any) {
      logger.warn(
        `[HealthMonitor] ${sessionCode} — attempt ${attempt} failed: ${err.message}`
      );
      if (attempt < MAX_RETRIES) {
        await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
      }
    }
  }

  // All retries exhausted — leave containerStatus = 'failed', next cycle will retry
  logger.error(
    `[HealthMonitor] ❌ ${sessionCode} — all ${MAX_RETRIES} attempts failed. Retrying next cycle.`
  );
  return { sessionCode, status: 'failed', error: 'Max retries exhausted' };
}

// ── Core scan ────────────────────────────────────────────────────────────────

async function runHealthScan(): Promise<void> {
  const scanStart = Date.now();
  logger.info('[HealthMonitor] 🔍 Scanning for failed or stuck provisioning sessions...');

  // ── On-demand provisioning model ─────────────────────────────────────────
  // Containers are now provisioned when the candidate clicks "Start Assessment",
  // NOT at invite time. This means pending sessions intentionally have no
  // containerUrl and containerStatus = 'pending'.
  //
  // The health monitor must ONLY repair sessions whose provisioning actually
  // started (status = 'failed' or stuck 'provisioning') — NOT sessions that
  // are simply waiting for the candidate to arrive.
  //
  // 'provisioning' stuck > 10 min = candidate clicked Start but backend crashed
  // mid-way. We treat those as 'failed' so the candidate can retry.
  const stuckProvisioningCutoff = new Date(Date.now() - 10 * 60 * 1000);

  const unhealthySessions = await (prisma.session as any).findMany({
    where: {
      status: 'pending',
      assignedVariantId: { not: null },
      AND: [
        {
          OR: [
            // Provisioning explicitly failed
            { containerStatus: 'failed' },
            // Stuck in 'provisioning' for more than 10 minutes (backend crash mid-provision).
            // Use createdAt as proxy — if the session is older than 10 min and still
            // shows 'provisioning', the backend crashed before it could finish.
            {
              containerStatus: 'provisioning',
              createdAt: { lt: stuckProvisioningCutoff },
            },
          ],
        },
        {
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } },
          ],
        },
      ],
    },
    select: {
      id: true,
      sessionCode: true,
      assignedVariantId: true,
      containerStatus: true,
    },
  });

  if (unhealthySessions.length === 0) {
    logger.info(
      `[HealthMonitor] ✅ All containers healthy (${Date.now() - scanStart}ms)`
    );
    return;
  }

  logger.warn(
    `[HealthMonitor] ⚠️  ${unhealthySessions.length} session(s) need repair — launching parallel jobs`
  );

  // ── Fire all repair jobs simultaneously ───────────────────────────────────
  // Promise.allSettled mirrors Server B's asyncio.gather — every job runs at
  // the same time. Total time = slowest single job, not the sum of all jobs.
  const results = await Promise.allSettled(
    unhealthySessions.map((s: any) => repairSession(s))
  );

  // ── Tally results ─────────────────────────────────────────────────────────
  let fixed = 0;
  let skipped = 0;
  let stillFailed = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.status === 'fixed')   fixed++;
      if (result.value.status === 'skipped') skipped++;
      if (result.value.status === 'failed')  stillFailed++;
    } else {
      // Promise itself rejected (unexpected error in repairSession)
      stillFailed++;
      logger.error(`[HealthMonitor] Unexpected repair error: ${result.reason}`);
    }
  }

  const elapsed = Date.now() - scanStart;
  logger.info(
    `[HealthMonitor] Done in ${elapsed}ms — ` +
    `fixed: ${fixed}, skipped: ${skipped}, still failed: ${stillFailed}`
  );
}

// ── Service lifecycle ─────────────────────────────────────────────────────────

/**
 * Start the monitor. Runs an immediate scan on boot, then on the configured interval.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startContainerHealthMonitor(): void {
  if (monitorTimer) return;

  logger.info(`[HealthMonitor] Starting — interval: ${INTERVAL_MS / 60_000} min`);

  // Immediate scan on boot — catches anything broken from last restart
  runHealthScan().catch(err =>
    logger.error(`[HealthMonitor] Boot scan error: ${err.message}`)
  );

  monitorTimer = setInterval(() => {
    runHealthScan().catch(err =>
      logger.error(`[HealthMonitor] Scheduled scan error: ${err.message}`)
    );
  }, INTERVAL_MS);

  // Don't keep the process alive on graceful shutdown
  if (monitorTimer.unref) monitorTimer.unref();
}

/**
 * Stop the monitor (tests / graceful shutdown).
 */
export function stopContainerHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    logger.info('[HealthMonitor] Stopped');
  }
}

/**
 * Trigger an immediate out-of-schedule scan (e.g. admin endpoint).
 */
export async function triggerHealthScan(): Promise<void> {
  await runHealthScan();
}
