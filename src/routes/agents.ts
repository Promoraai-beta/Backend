import { Router, Request, Response } from 'express';
import { watchSession, executeAnalysis, flagSanityChecks } from '../mcp/servers/serverC';
import { authenticate } from '../middleware/rbac';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const router = Router();

// All agent endpoints require authentication (recruiter-only)
router.use(authenticate);

// Helper function to verify session access
async function verifySessionAccess(sessionId: string, userId: string, userRole: string): Promise<boolean> {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        assessment: {
          include: {
            company: true
          }
        }
      }
    });

    if (!session) return false;

    // Only recruiter assessments are accessible
    if (session.assessment?.assessmentType !== 'recruiter') return false;

    // Verify recruiter has access to this company's assessments
    if (userRole === 'recruiter' && session.assessment?.company?.id) {
      const recruiter = await prisma.recruiterProfile.findUnique({
        where: { userId: userId },
        include: { company: true }
      });
      return recruiter?.companyId === session.assessment.company.id;
    }

    return userRole === 'recruiter';
  } catch (error) {
    logger.error('Error verifying session access:', error);
    return false;
  }
}

// Get real-time violations using MCP Server C (Agent 6)
router.get('/watcher/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    // Verify access
    const hasAccess = await verifySessionAccess(sessionId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied to this session' });
    }

    // Use MCP Server C Agent 6
    const result = await watchSession(sessionId, true, true);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get comprehensive analysis using MCP Server C (Agent 7)
router.get('/extractor/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    // Verify access
    const hasAccess = await verifySessionAccess(sessionId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied to this session' });
    }

    // Use MCP Server C Agent 7
    const result = await executeAnalysis(sessionId);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get risk assessment using MCP Server C (Agent 8)
router.get('/sanity/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    // Verify access
    const hasAccess = await verifySessionAccess(sessionId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied to this session' });
    }

    // Use MCP Server C Agent 8
    const result = await flagSanityChecks(sessionId);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get complete report (all MCP Server C agents)
// Stores results in database for faster subsequent retrievals
router.get('/full-report/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    const forceRefresh = req.query.refresh === 'true'; // Optional: force recomputation

    // Verify access
    const hasAccess = await verifySessionAccess(sessionId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied to this session' });
    }

    // Check if insights exist in database (unless force refresh)
    if (!forceRefresh) {
      const existingInsights = await prisma.agentInsight.findUnique({
        where: { sessionId }
      });

      if (existingInsights) {
        // Return cached insights from database
        logger.log(`📊 Returning cached agent insights for session ${sessionId} (computed at: ${existingInsights.computedAt})`);
        return res.json({
          success: true,
          report: {
            watcher: existingInsights.watcher || null,
            extractor: existingInsights.extractor || null,
            sanity: existingInsights.sanity || null
          },
          cached: true,
          computedAt: existingInsights.computedAt,
          version: existingInsights.version
        });
      }
    }

    // No cached insights or force refresh - compute new insights
    logger.log(`🔄 Computing new agent insights for session ${sessionId}...`);
    
    // Run all MCP Server C agents in parallel for faster response
    const [watcher, extractor, sanity] = await Promise.all([
      watchSession(sessionId, true, true).catch(err => {
        logger.error('Watcher agent error:', err);
        return { success: false, error: err.message, violations: [], riskScore: 0 };
      }),
      executeAnalysis(sessionId).catch(err => {
        logger.error('Extractor agent error:', err);
        return { success: false, error: err.message, behaviorScore: 0 };
      }),
      flagSanityChecks(sessionId).catch(err => {
        logger.error('Sanity agent error:', err);
        return { success: false, error: err.message, redFlags: [], riskScore: 0 };
      })
    ]);

    // Store insights in database (upsert - create or update)
    try {
      const existing = await prisma.agentInsight.findUnique({
        where: { sessionId }
      });

      if (existing) {
        // Update existing insights
        await prisma.agentInsight.update({
          where: { sessionId },
          data: {
            watcher: watcher as any,
            extractor: extractor as any,
            sanity: sanity as any,
            computedAt: new Date(),
            version: existing.version + 1,
            updatedAt: new Date()
          }
        });
        logger.log(`✅ Updated agent insights for session ${sessionId} (version ${existing.version + 1})`);
      } else {
        // Create new insights
        await prisma.agentInsight.create({
          data: {
            sessionId,
            watcher: watcher as any,
            extractor: extractor as any,
            sanity: sanity as any,
            computedAt: new Date(),
            version: 1
          }
        });
        logger.log(`✅ Stored new agent insights for session ${sessionId}`);
      }
    } catch (dbError: any) {
      // Log error but don't fail the request - insights are computed and returned
      logger.error('⚠️ Failed to store agent insights in database:', dbError.message);
      // Continue to return insights even if database storage fails
    }

    res.json({
      success: true,
      report: {
        watcher,
        extractor,
        sanity
      },
      cached: false,
      computedAt: new Date().toISOString()
    });
  } catch (error: any) {
    logger.error('Error in full-report endpoint:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

