/**
 * Database Explorer Routes
 * Proxies SQLite queries into the candidate's running Docker container.
 *
 * GET  /api/sessions/:sessionId/db/schema   → table list + columns + row counts
 * POST /api/sessions/:sessionId/db/query    → run a SELECT/PRAGMA query
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/rbac';
import { queryContainerDatabase, getContainerDatabaseSchema } from '../services/local-docker-provisioner';
import { logger } from '../lib/logger';

const router = Router();

// ── Resolve the container ID for a session ────────────────────────────────────

async function resolveContainerId(sessionId: string): Promise<string | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { containerId: true },
  });
  return session?.containerId ?? null;
}

// ── GET /api/sessions/:sessionId/db/schema ────────────────────────────────────

router.get('/:sessionId/db/schema', authenticate, async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  try {
    const containerId = await resolveContainerId(sessionId);
    if (!containerId) {
      return res.status(404).json({ error: 'No running container for this session. Start the IDE first.' });
    }

    const schema = await getContainerDatabaseSchema(containerId);
    return res.json(schema);
  } catch (err: any) {
    logger.error(`[DB schema] Session ${sessionId}:`, err.message);
    return res.status(500).json({ error: err.message || 'Failed to read database schema' });
  }
});

// ── POST /api/sessions/:sessionId/db/query ────────────────────────────────────

router.post('/:sessionId/db/query', authenticate, async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { sql } = req.body as { sql?: string };

  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ error: 'sql is required' });
  }
  if (sql.trim().length > 4000) {
    return res.status(400).json({ error: 'Query too long (max 4000 chars)' });
  }

  try {
    const containerId = await resolveContainerId(sessionId);
    if (!containerId) {
      return res.status(404).json({ error: 'No running container for this session. Start the IDE first.' });
    }

    const start = Date.now();
    const result = await queryContainerDatabase(containerId, sql.trim());
    const executionMs = Date.now() - start;

    return res.json({ ...result, executionMs });
  } catch (err: any) {
    logger.error(`[DB query] Session ${sessionId}:`, err.message);
    return res.status(500).json({ error: err.message || 'Query failed' });
  }
});

export default router;
