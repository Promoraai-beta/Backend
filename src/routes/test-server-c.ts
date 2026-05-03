/**
 * Test routes for test-ide page: sandbox session + Server C check.
 * No auth required - dev/testing only.
 */
import { Router, Request, Response } from 'express';
import { watchSession, executeAnalysis, flagSanityChecks } from '../mcp/servers/serverC';
import { computeSessionMetrics } from '../services/metrics';
import { judgeSession } from '../services/session-judge';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { listLocalContainers } from '../services/local-docker-provisioner';

const router = Router();
// Must be a valid UUID so POST /api/ai-interactions validation accepts it
const SANDBOX_SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** GET /api/test/sandbox-session - Create or return test session so test-ide events are stored */
router.get('/sandbox-session', async (_req: Request, res: Response) => {
  try {
    // Find the most recent running Docker container for this session's short ID prefix
    const shortId = SANDBOX_SESSION_ID.split('-')[0]; // 'a1b2c3d4'
    const allContainers = await listLocalContainers();
    const matching = allContainers
      .filter(c => c.name.includes(shortId) && c.state === 'running')
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    const latestContainer = matching[0];

    const updateData: Record<string, unknown> = { status: 'active' };
    if (latestContainer) {
      updateData.containerId = latestContainer.id;
      if (latestContainer.codeServerPort) {
        updateData.containerUrl = `http://localhost:${latestContainer.codeServerPort}`;
      }
    }

    const session = await prisma.session.upsert({
      where: { id: SANDBOX_SESSION_ID },
      create: {
        id: SANDBOX_SESSION_ID,
        sessionCode: 'TESTSANDBOX',
        status: 'active',
        timeLimit: 3600,
        containerId: latestContainer?.id ?? null,
        containerUrl: latestContainer?.codeServerPort
          ? `http://localhost:${latestContainer.codeServerPort}`
          : null,
      },
      update: updateData as any,
    });

    if (latestContainer) {
      logger.log(`[Test] Sandbox session linked to container: ${latestContainer.name} (${latestContainer.id})`);
    }

    res.json({ success: true, sessionId: session.id });
  } catch (error: any) {
    logger.error('[Test] Sandbox session failed:', error);
    res.status(500).json({ success: false, error: error?.message });
  }
});

/** GET /api/test/server-c - Verify MCP Server C and return violations for test session */
router.get('/server-c', async (req: Request, res: Response) => {
  try {
    const sessionId = (req.query.sessionId as string) || SANDBOX_SESSION_ID;
    logger.log('[Test] Checking Server C connectivity for session:', sessionId);
    const result = await watchSession(sessionId, true, true);
    res.json({
      success: true,
      message: 'Server C (monitoring) is reachable and responding',
      serverC: {
        watcher: {
          success: result.success,
          violationsCount: result.violations?.length ?? 0,
          riskScore: result.riskScore ?? 0,
          violations: result.violations ?? [],
        },
      },
      raw: result,
    });
  } catch (error: any) {
    logger.error('[Test] Server C check failed:', error);
    res.status(500).json({
      success: false,
      message: 'Server C is not reachable',
      error: error?.message || String(error),
      hint: 'Ensure MCP servers are running: cd mcp-servers && python test-mcp-servers.py',
    });
  }
});

/** GET /api/test/full-report - Full report for sandbox session (no auth). Use after testing the whole flow. */
router.get('/full-report', async (_req: Request, res: Response) => {
  const sessionId = SANDBOX_SESSION_ID;
  try {
    const [interactions, submissions] = await Promise.all([
      prisma.aiInteraction.findMany({ where: { sessionId }, orderBy: { timestamp: 'asc' } }),
      prisma.submission.findMany({ where: { sessionId }, orderBy: { submittedAt: 'desc' } }),
    ]);
    const metrics = computeSessionMetrics(interactions, submissions);

    const [watcher, extractor, sanity, judge] = await Promise.all([
      watchSession(sessionId, true, true).catch(err => {
        logger.error('[Test] Watcher error:', err);
        return { success: false, error: err?.message, violations: [], riskScore: 0 };
      }),
      executeAnalysis(sessionId).catch(err => {
        logger.error('[Test] Extractor error:', err);
        return { success: false, error: err?.message, behaviorScore: 0 };
      }),
      flagSanityChecks(sessionId).catch(err => {
        logger.error('[Test] Sanity error:', err);
        return { success: false, error: err?.message, redFlags: [], riskScore: 0 };
      }),
      judgeSession(sessionId).catch(() => null),
    ]);

    res.json({
      success: true,
      report: {
        watcher,
        extractor,
        sanity,
        judge: judge || null,
        metrics: {
          promptQuality: metrics.promptQuality,
          selfReliance: metrics.selfReliance,
          promptCount: metrics.promptCount,
          copyCount: metrics.copyCount,
        },
      },
      generatedAt: new Date().toISOString(),
      sessionId,
    });
  } catch (error: any) {
    logger.error('[Test] Full report failed:', error);
    res.status(500).json({
      success: false,
      error: error?.message || String(error),
    });
  }
});

export default router;
