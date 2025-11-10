import { Router } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

// Get all submissions (optionally filtered by session_id)
router.get('/', async (req, res) => {
  try {
    const { session_id } = req.query;

    const where = session_id ? { sessionId: session_id as string } : {};

    const data = await prisma.submission.findMany({
      where,
      orderBy: {
        submittedAt: 'desc'
      }
    });

    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get submission by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const data = await prisma.submission.findUnique({
      where: { id }
    });

    if (!data) {
      return res.status(404).json({ success: false, error: 'Submission not found' });
    }

    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

