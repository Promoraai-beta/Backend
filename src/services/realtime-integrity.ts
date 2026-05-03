/**
 * Real-time integrity: run Server C watcher when new events arrive,
 * debounced per session, and store result in AgentInsight.
 * Keeps session integrity state up to date for end-of-assessment report and future voice agent.
 * Also runs LLM judge (integrity + AI usage quality) with longer debounce.
 */

import { watchSession } from '../mcp/servers/serverC';
import { judgeSession } from './session-judge';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const DEBOUNCE_MS = 4000; // Run watcher 4s after last event
const JUDGE_DEBOUNCE_MS = 30000; // Run LLM judge 30s after last event (cost control)

const pendingBySession = new Map<string, NodeJS.Timeout>();
const judgePendingBySession = new Map<string, NodeJS.Timeout>();

/**
 * Schedule a real-time integrity run for this session.
 * Each new event resets the timer; analysis runs once after activity settles.
 * Also schedules the LLM judge with a longer debounce.
 */
export function scheduleRealtimeIntegrity(sessionId: string): void {
  const existing = pendingBySession.get(sessionId);
  if (existing) clearTimeout(existing);

  const timeout = setTimeout(() => {
    pendingBySession.delete(sessionId);
    runRealtimeIntegrity(sessionId).catch(() => {});
  }, DEBOUNCE_MS);

  pendingBySession.set(sessionId, timeout);

  scheduleRealtimeJudge(sessionId);
}

/**
 * Schedule a real-time LLM judge run for this session.
 * Longer debounce (30s) to limit API cost.
 */
export function scheduleRealtimeJudge(sessionId: string): void {
  const existing = judgePendingBySession.get(sessionId);
  if (existing) clearTimeout(existing);

  const timeout = setTimeout(() => {
    judgePendingBySession.delete(sessionId);
    runRealtimeJudge(sessionId).catch(() => {});
  }, JUDGE_DEBOUNCE_MS);

  judgePendingBySession.set(sessionId, timeout);
}

/**
 * Run watcher for the session and upsert AgentInsight.watcher.
 * Does not block; errors are logged.
 */
export async function runRealtimeIntegrity(sessionId: string): Promise<void> {
  try {
    const watcher = await watchSession(sessionId, true, true);

    const existing = await prisma.agentInsight.findUnique({
      where: { sessionId }
    });

    if (existing) {
      await prisma.agentInsight.update({
        where: { sessionId },
        data: {
          watcher: watcher as object,
          computedAt: new Date(),
          version: existing.version + 1
        }
      });
      logger.log(`[RealtimeIntegrity] Updated watcher for session ${sessionId}`);
    } else {
      await prisma.agentInsight.create({
        data: {
          sessionId,
          watcher: watcher as object,
          computedAt: new Date()
        }
      });
      logger.log(`[RealtimeIntegrity] Created watcher for session ${sessionId}`);
    }
  } catch (err: any) {
    logger.error('[RealtimeIntegrity] Failed for session', sessionId, err?.message || err);
  }
}

/**
 * Run LLM judge for the session and upsert AgentInsight.judge.
 * Evaluates integrity + AI usage quality across whole assessment flow.
 */
export async function runRealtimeJudge(sessionId: string): Promise<void> {
  try {
    const result = await judgeSession(sessionId);
    if (!result) return;

    const existing = await prisma.agentInsight.findUnique({
      where: { sessionId }
    });

    const judgePayload = { ...result, judgedAt: new Date().toISOString() };

    if (existing) {
      await prisma.agentInsight.update({
        where: { sessionId },
        data: { judge: judgePayload as object }
      });
      logger.log(`[RealtimeJudge] Updated judge for session ${sessionId}`);
    } else {
      await prisma.agentInsight.create({
        data: {
          sessionId,
          judge: judgePayload as object
        }
      });
      logger.log(`[RealtimeJudge] Created judge for session ${sessionId}`);
    }
  } catch (err: any) {
    logger.error('[RealtimeJudge] Failed for session', sessionId, err?.message || err);
  }
}
