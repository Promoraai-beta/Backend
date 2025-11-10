/**
 * MCP Database API Routes
 * Provides database access for Python MCP servers via HTTP API
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

/**
 * GET /api/mcp-database/interactions/:sessionId
 * Get all AI interactions for a session
 */
router.get('/interactions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const interactions = await prisma.aiInteraction.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' }
    });
    
    res.json(interactions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mcp-database/submissions/:sessionId
 * Get submissions for a session
 */
router.get('/submissions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const submissions = await prisma.submission.findMany({
      where: { sessionId },
      orderBy: { submittedAt: 'asc' }
    });
    
    res.json(submissions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mcp-database/code-snapshots/:sessionId
 * Get code snapshots for a session
 */
router.get('/code-snapshots/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const snapshots = await prisma.codeSnapshot.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' }
    });
    
    res.json(snapshots);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mcp-database/file-operations/:sessionId
 * Get file operations for a session
 */
router.get('/file-operations/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const fileOps = await prisma.aiInteraction.findMany({
      where: {
        sessionId,
        eventType: {
          in: ['file_created', 'file_modified', 'file_deleted', 'file_renamed']
        }
      },
      orderBy: { timestamp: 'asc' }
    });
    
    res.json(fileOps);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mcp-database/terminal-events/:sessionId
 * Get terminal events for a session
 */
router.get('/terminal-events/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const terminalEvents = await prisma.aiInteraction.findMany({
      where: {
        sessionId,
        eventType: {
          in: ['terminal_spawned', 'command_executed']
        }
      },
      orderBy: { timestamp: 'asc' }
    });
    
    res.json(terminalEvents);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mcp-database/interactions-by-type/:sessionId
 * Get interactions by event type
 */
router.get('/interactions-by-type/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { eventTypes } = req.query;
    
    if (!eventTypes || typeof eventTypes !== 'string') {
      return res.status(400).json({ error: 'eventTypes query parameter is required' });
    }
    
    const types = eventTypes.split(',');
    
    const interactions = await prisma.aiInteraction.findMany({
      where: {
        sessionId,
        eventType: {
          in: types
        }
      },
      orderBy: { timestamp: 'asc' }
    });
    
    res.json(interactions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mcp-database/recent-interactions/:sessionId
 * Get recent interactions (last N events)
 */
router.get('/recent-interactions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    
    const interactions = await prisma.aiInteraction.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'desc' },
      take: limit
    });
    
    res.json(interactions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/mcp-database/session-status/:sessionId
 * Check if session is active
 */
router.get('/session-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { status: true }
    });
    
    res.json({
      isActive: session?.status === 'active',
      status: session?.status || 'unknown'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

