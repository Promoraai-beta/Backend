/**
 * Container Management Routes
 * Handles local Docker container provisioning and lifecycle for assessments
 */

import { Router, Request, Response } from 'express';
import { provisionLocalContainer, deleteLocalContainer, getLocalContainerStatus, cleanupOldLocalContainers, listLocalContainers } from '../services/local-docker-provisioner';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const router = Router();

// No auth required for test routes - can add authenticate middleware later for production

/**
 * POST /api/containers/provision/:sessionId
 * Create local Docker container for an assessment session
 */
router.post('/provision/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    logger.log(`[Containers] Provision request for session: ${sessionId}`);

    // Check if container already exists
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { containerId: true, containerUrl: true },
    });

    if (session?.containerId && session?.containerUrl) {
      logger.log(`[Containers] Container already exists for session ${sessionId}`);
      return res.json({
        success: true,
        message: 'Container already exists',
        container: {
          containerId: session.containerId,
          codeServerUrl: session.containerUrl,
          status: 'running',
        },
      });
    }

    // Provision local Docker container
    const result = await provisionLocalContainer(sessionId);

    // Store container info in session
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        containerId: result.containerId,
        containerUrl: result.codeServerUrl,
      },
    });

    logger.log(`[Containers] Container provisioned successfully for session ${sessionId}`);

    res.json({
      success: true,
      container: result,
    });
  } catch (error: any) {
    logger.error('[Containers] Provision API error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to provision container',
    });
  }
});

/**
 * GET /api/containers/status/:sessionId
 * Get container status for a session
 */
router.get('/status/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { containerId: true, containerUrl: true },
    });

    if (!session?.containerId) {
      return res.json({
        success: true,
        status: 'not-found',
        message: 'No container found for this session',
      });
    }

    const status = await getLocalContainerStatus(session.containerId);

    res.json({
      success: true,
      status,
      containerUrl: session.containerUrl,
    });
  } catch (error: any) {
    logger.error('[Containers] Status API error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get container status',
    });
  }
});

/**
 * DELETE /api/containers/:sessionId
 * Delete Azure Container Instance for a session
 */
router.delete('/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    logger.log(`[Containers] Delete request for session: ${sessionId}`);

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { containerId: true },
    });

    if (session?.containerId) {
      await deleteLocalContainer(session.containerId);
      await prisma.session.update({
        where: { id: sessionId },
        data: { containerId: null, containerUrl: null },
      });
      logger.log(`[Containers] Container deleted for session ${sessionId}`);
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error('[Containers] Delete API error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete container',
    });
  }
});

/**
 * POST /api/containers/cleanup
 * Manually trigger cleanup of old/stale local Docker containers
 * Query params: maxAgeHours (default: 24)
 */
router.post('/cleanup', async (req: Request, res: Response) => {
  try {
    const maxAgeHours = parseInt(req.query.maxAgeHours as string) || 24;
    
    logger.log(`[Containers] Manual cleanup requested (maxAgeHours: ${maxAgeHours})`);

    const deletedCount = await cleanupOldLocalContainers(maxAgeHours);
    const containers = await listLocalContainers();

    res.json({
      success: true,
      deletedCount,
      containers: containers.length,
      message: `Cleaned up ${deletedCount} old containers. Current containers: ${containers.length}`
    });
  } catch (error: any) {
    logger.error('[Containers] Cleanup API error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to cleanup containers',
    });
  }
});

/**
 * GET /api/containers/quota
 * Get current local Docker container list
 */
router.get('/quota', async (req: Request, res: Response) => {
  try {
    const containers = await listLocalContainers();

    res.json({
      success: true,
      containers: containers.length,
      containerList: containers.map(c => ({
        name: c.name,
        state: c.state,
        createdAt: c.createdAt
      }))
    });
  } catch (error: any) {
    logger.error('[Containers] List API error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to list containers',
    });
  }
});

export default router;
