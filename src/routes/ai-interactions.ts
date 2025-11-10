import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { aiInteractionLimiter } from '../middleware/rate-limiter';
import { validateAIIntraction } from '../middleware/validation';

const router = Router();

// Track AI interaction
router.post('/', aiInteractionLimiter, validateAIIntraction, async (req: Request, res: Response) => {
  try {
    const { sessionId, eventType, model, promptText, responseText, tokensUsed, codeSnippet, codeLineNumber, codeBefore, codeAfter, metadata } = req.body;

    if (!sessionId || !eventType) {
      return res.status(400).json({ success: false, error: 'sessionId and eventType are required' });
    }

    const interaction = await prisma.aiInteraction.create({
      data: {
        sessionId,
        eventType,
        model: model || null,
        promptText: promptText || null,
        responseText: responseText || null,
        tokensUsed: tokensUsed || null,
        codeSnippet: codeSnippet || null,
        codeLineNumber: codeLineNumber || null,
        codeBefore: codeBefore || null,
        codeAfter: codeAfter || null,
        metadata: metadata || null
      }
    });

    res.json({ success: true, data: interaction });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get AI interactions for a session
router.get('/', async (req: Request, res: Response) => {
  try {
    const sessionId = req.query.session_id as string;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'session_id required' });
    }

    const data = await prisma.aiInteraction.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' }
    });

    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

