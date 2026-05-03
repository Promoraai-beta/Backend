/**
 * Container Keep-Alive Service
 *
 * Responsibility: ensure the Azure Container Instance for every active/pending
 * assessment session is ALWAYS live before a candidate opens the IDE tab.
 *
 * Strategy:
 *  - Every CHECK_INTERVAL_MS, find all sessions that have a containerUrl stored
 *    (meaning the recruiter pre-provisioned a container) AND whose status is
 *    still 'pending' or 'active' (session not yet finished).
 *  - For each such session, do a fast no-cors-style HEAD probe from Node.js.
 *  - If the container responds → great, nothing to do.
 *  - If the container is dead → provision a fresh Azure Container Instance,
 *    update the DB with the new URL, and log the reprovision.
 *
 * This runs entirely server-side and is invisible to the candidate.
 * The candidate always hits the preProvisionedUrl fast-path in the frontend.
 */

import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { provisionAssessmentContainer } from './azure-provisioner';

// ── Configuration ────────────────────────────────────────────────────────────

/** How often to run the health sweep (default: every 10 minutes). */
const CHECK_INTERVAL_MS =
  parseInt(process.env.CONTAINER_KEEPALIVE_INTERVAL_MS || '600000', 10);

/** Timeout for each individual liveness probe. */
const PROBE_TIMEOUT_MS =
  parseInt(process.env.CONTAINER_PROBE_TIMEOUT_MS || '5000', 10);

/** Only run when Azure is configured (not local Docker). */
const USE_LOCAL_DOCKER = process.env.USE_LOCAL_DOCKER === 'true';

// ── Error-rate limiting ───────────────────────────────────────────────────────

let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;
let lastErrorTime = 0;
const ERROR_LOG_INTERVAL_MS = 300_000; // log at most once per 5 min

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Probe a single container URL from Node.js.
 * Returns true if the server responds (any HTTP status — code-server is up),
 * false if the connection is refused / times out.
 */
async function isContainerAlive(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true; // any HTTP response = server is up
  } catch {
    return false; // connection refused / timed out = container dead
  }
}

/**
 * Run one full keep-alive sweep across all sessions with a stored containerUrl.
 */
export async function runContainerKeepalive(): Promise<{
  checked: number;
  alive: number;
  reprovisioned: number;
  errors: number;
  skipped?: boolean;
}> {
  if (USE_LOCAL_DOCKER) {
    // Keep-alive is only for Azure containers.
    return { checked: 0, alive: 0, reprovisioned: 0, errors: 0, skipped: true };
  }

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    return { checked: 0, alive: 0, reprovisioned: 0, errors: 0, skipped: true };
  }

  try {
    // Sessions that have a container pre-provisioned and are not yet finished.
    const sessions = await prisma.session.findMany({
      where: {
        containerUrl: { not: null },
        status: { in: ['pending', 'active'] },
      },
      select: {
        id: true,
        sessionCode: true,
        containerUrl: true,
        containerId: true,
      },
    });

    consecutiveErrors = 0; // DB call succeeded

    if (sessions.length === 0) {
      return { checked: 0, alive: 0, reprovisioned: 0, errors: 0 };
    }

    logger.log(
      `[Container Keep-Alive] Checking ${sessions.length} pre-provisioned container(s)…`
    );

    let alive = 0;
    let reprovisioned = 0;
    let errors = 0;

    // Probe all containers concurrently for speed, then reprovision failures sequentially
    // (provisioning is slow; no need to paralelise it — avoids hammering Azure).
    const probeResults = await Promise.all(
      sessions.map(async (s) => ({
        session: s,
        alive: await isContainerAlive(s.containerUrl!),
      }))
    );

    const dead = probeResults.filter((r) => !r.alive);
    alive = probeResults.length - dead.length;

    for (const { session } of dead) {
      logger.warn(
        `[Container Keep-Alive] Container dead for session ${session.sessionCode} — reprovisioning…`
      );
      try {
        // Provision a fresh Azure Container Instance.
        const result = await provisionAssessmentContainer(session.id);

        // Update the DB record with the new container details.
        const newPreviewUrl = result.codeServerUrl.replace(/:8080\/?$/, ':5173');
        await prisma.session.update({
          where: { id: session.id },
          data: {
            containerId: result.containerId,
            containerUrl: result.codeServerUrl,
            previewUrl: newPreviewUrl,
            supportsDirectPreview: true,
          },
        });

        logger.log(
          `[Container Keep-Alive] ✅ Reprovisioned session ${session.sessionCode} → ${result.codeServerUrl} (preview: ${newPreviewUrl})`
        );
        reprovisioned++;
      } catch (err: any) {
        errors++;
        logger.error(
          `[Container Keep-Alive] ❌ Failed to reprovision session ${session.sessionCode}:`,
          err?.message || err
        );
      }
    }

    logger.log(
      `[Container Keep-Alive] Sweep done — alive: ${alive}, reprovisioned: ${reprovisioned}, errors: ${errors}`
    );

    return { checked: sessions.length, alive, reprovisioned, errors };
  } catch (err: any) {
    consecutiveErrors++;
    const now = Date.now();
    if (now - lastErrorTime > ERROR_LOG_INTERVAL_MS || consecutiveErrors === 1) {
      logger.error('[Container Keep-Alive] Sweep failed:', err?.message || err);
      lastErrorTime = now;
    }
    return { checked: 0, alive: 0, reprovisioned: 0, errors: 1 };
  }
}

// ── Service lifecycle ─────────────────────────────────────────────────────────

/**
 * Start the keep-alive background service.
 * Returns a cleanup function that stops the interval.
 */
export function startContainerKeepalive(): () => void {
  if (USE_LOCAL_DOCKER) {
    logger.log('[Container Keep-Alive] Skipped (USE_LOCAL_DOCKER=true)');
    return () => {};
  }

  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  if (!subscriptionId) {
    logger.log('[Container Keep-Alive] Skipped (AZURE_SUBSCRIPTION_ID not set)');
    return () => {};
  }

  logger.log(
    `[Container Keep-Alive] Starting — sweep every ${CHECK_INTERVAL_MS / 1000 / 60} min`
  );

  // First sweep after 2 minutes (give the server time to fully start).
  const initialTimer = setTimeout(() => {
    runContainerKeepalive().catch(() => {});
  }, 2 * 60 * 1000);

  // Then sweep on the configured interval.
  const intervalId = setInterval(() => {
    runContainerKeepalive().catch(() => {});
  }, CHECK_INTERVAL_MS);

  return () => {
    clearTimeout(initialTimer);
    clearInterval(intervalId);
    logger.log('[Container Keep-Alive] Stopped');
  };
}
