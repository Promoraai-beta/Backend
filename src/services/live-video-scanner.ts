/**
 * Live Video Scanner — periodic screenshare analysis during active sessions
 *
 * Strategy:
 *  • Every SCAN_INTERVAL_MS (5 min), check suspicion signals for all tracked sessions
 *  • If signals are present (tab switches or elevated watcher risk score), run a
 *    lightweight video analysis on the chunks collected so far
 *  • Results are merged into AgentInsight.geminiVideoAnalysis in the DB so the
 *    recruiter sees a live-updated screenshare verdict on the results page
 *
 * Suspicion signals (any one triggers a scan):
 *  - tabSwitchCount >= 1
 *  - watcher riskScore > 20
 *  - no scan yet and session has been running > FIRST_SCAN_AFTER_MS
 *
 * Cost control:
 *  - Capped at MAX_MID_SESSION_FRAMES (10) per scan — faster, cheaper
 *  - At most one concurrent scan per session (guarded by inProgress set)
 *  - Sessions are automatically deregistered on end/error
 */

import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { analyzeSessionVideo } from './gemini-video-analysis';

// ── Config ────────────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS   = 5 * 60 * 1000;  // Check every 5 minutes
const FIRST_SCAN_AFTER_MS = 5 * 60 * 1000;  // First scan triggers at ≥5 min elapsed
const TAB_SWITCH_THRESHOLD = 1;              // Any tab switch triggers a scan
const RISK_SCORE_THRESHOLD = 20;            // Watcher risk score that triggers a scan

// ── State ─────────────────────────────────────────────────────────────────────

/** sessionId → timer started at */
const tracked = new Map<string, { startedAt: number; lastScanAt: number | null }>();

/** sessions currently being scanned (prevent double-run) */
const inProgress = new Set<string>();

/** singleton interval reference */
let intervalRef: NodeJS.Timeout | null = null;

/** Global concurrency semaphore — limits simultaneous AI video scans */
let activeScanCount = 0;
const MAX_CONCURRENT_SCANS = 3;

// ── Public API ────────────────────────────────────────────────────────────────

/** Call when a session becomes active (status = 'active') */
export function startLiveVideoScan(sessionId: string): void {
  if (tracked.has(sessionId)) return;
  tracked.set(sessionId, { startedAt: Date.now(), lastScanAt: null });
  logger.log(`[LiveVideoScan] Tracking session ${sessionId} (${tracked.size} total active)`);
  ensureIntervalRunning();
}

/** Call when a session ends or errors — cleans up state */
export function stopLiveVideoScan(sessionId: string): void {
  tracked.delete(sessionId);
  inProgress.delete(sessionId);
  logger.log(`[LiveVideoScan] Deregistered session ${sessionId} (${tracked.size} remaining)`);
  if (tracked.size === 0 && intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
    logger.log('[LiveVideoScan] No active sessions — interval stopped');
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function ensureIntervalRunning(): void {
  if (intervalRef) return;
  intervalRef = setInterval(scanAllSessions, SCAN_INTERVAL_MS);
  logger.log(`[LiveVideoScan] Started scan interval (every ${SCAN_INTERVAL_MS / 60000} min)`);
}

async function scanAllSessions(): Promise<void> {
  if (tracked.size === 0) return;
  logger.log(`[LiveVideoScan] Tick — checking ${tracked.size} active session(s)`);

  for (const [sessionId, meta] of tracked.entries()) {
    if (inProgress.has(sessionId)) continue; // already running

    try {
      const shouldScan = await needsScan(sessionId, meta);
      if (shouldScan) {
        // Fire-and-forget; errors are caught inside runScan
        runScan(sessionId).catch(() => {});
      }
    } catch (err: any) {
      logger.warn(`[LiveVideoScan] Error evaluating ${sessionId}: ${err.message}`);
    }
  }
}

async function needsScan(
  sessionId: string,
  meta: { startedAt: number; lastScanAt: number | null }
): Promise<boolean> {
  const elapsed = Date.now() - meta.startedAt;
  if (elapsed < FIRST_SCAN_AFTER_MS) return false; // too early

  // Fetch session + latest watcher insight in one go
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { status: true, tabSwitchCount: true }
  });

  if (!session || session.status !== 'active') {
    stopLiveVideoScan(sessionId); // session ended externally
    return false;
  }

  // First scan (no previous scan) — run unconditionally after FIRST_SCAN_AFTER_MS
  if (meta.lastScanAt === null) return true;

  // Tab switch threshold — safe fallback handles schema variations
  const tabSwitchCount = (session as any).tabSwitchCount ?? (session as any).tabSwitches ?? 0;
  if (tabSwitchCount >= TAB_SWITCH_THRESHOLD) return true;

  // Watcher risk score threshold — check AgentInsight separately
  const insight = await prisma.agentInsight.findUnique({
    where: { sessionId },
    select: { watcher: true }
  });
  const watcher = insight?.watcher as any;
  if (watcher?.riskScore > RISK_SCORE_THRESHOLD) return true;

  return false;
}

async function runScan(sessionId: string): Promise<void> {
  if (activeScanCount >= MAX_CONCURRENT_SCANS) {
    logger.log('[LiveScanner] Concurrency limit reached, skipping scan');
    return;
  }

  inProgress.add(sessionId);
  activeScanCount++;
  const meta = tracked.get(sessionId);
  logger.log(`[LiveVideoScan] Running mid-session scan for ${sessionId}... (active: ${activeScanCount}/${MAX_CONCURRENT_SCANS})`);

  try {
    // Run video analysis — proportional frame cap applied inside analyzeSessionVideo
    const result = await analyzeSessionVideo(sessionId);

    if (!result) {
      logger.log(`[LiveVideoScan] No result for ${sessionId} (no chunks yet or API unavailable)`);
      return;
    }

    logger.log(
      `[LiveVideoScan] ✅ Mid-session verdict for ${sessionId}: ` +
      `${result.overallVerdict} (${result.confidence} confidence, ${result.framesAnalyzed} frames)`
    );

    // Merge into AgentInsight — tag as a live scan so recruiter can tell it's mid-session
    const liveResult = {
      ...result,
      liveScannedAt: new Date().toISOString(),
      midSession: true,
    };

    await prisma.agentInsight.upsert({
      where: { sessionId },
      update: {
        geminiVideoAnalysis: liveResult as any,
        updatedAt: new Date(),
      },
      create: {
        sessionId,
        geminiVideoAnalysis: liveResult as any,
        computedAt: new Date(),
        version: 1,
      },
    });

    // If high-risk verdict, also trigger a watcher run immediately
    if (result.overallVerdict === 'distracted' || result.suspiciousActivity.length > 0) {
      logger.log(`[LiveVideoScan] Suspicious activity detected — triggering watcher for ${sessionId}`);
      try {
        const mod = await import('./realtime-integrity');
        mod.scheduleRealtimeIntegrity(sessionId);
      } catch (e: any) {
        console.warn('[LiveScanner] realtime-integrity module not available:', e.message);
      }
    }

    // Update meta
    if (meta) meta.lastScanAt = Date.now();

  } catch (err: any) {
    logger.error(`[LiveVideoScan] Scan failed for ${sessionId}: ${err.message}`);
  } finally {
    inProgress.delete(sessionId);
    activeScanCount--;
  }
}
