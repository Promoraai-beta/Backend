/**
 * Integrity routes: LLM judge (integrity + AI usage quality).
 * GET /api/integrity/judge/:sessionId - Returns current judge result from AgentInsight.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, checkSessionOwnership } from '../middleware/rbac';

const router = Router();

router.use(authenticate);

router.get('/judge/:sessionId', checkSessionOwnership, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const insights = await prisma.agentInsight.findUnique({
      where: { sessionId }
    });

    return res.json({
      success: true,
      judge: insights?.judge || null,
      hasJudge: !!insights?.judge
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
