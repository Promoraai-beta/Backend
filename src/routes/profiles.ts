import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import jwt from 'jsonwebtoken';
import { logger } from '../lib/logger';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware to verify JWT token
const authenticateToken = (req: Request, res: Response, next: any) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    (req as any).userId = decoded.userId;
    (req as any).userRole = decoded.role;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Invalid token'
    });
  }
};

// Get candidate profile
router.get('/candidate', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        candidateProfile: true
      }
    });

    if (!user || user.role !== 'candidate') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Candidate profile only.'
      });
    }

    if (!user.candidateProfile) {
      // Create profile if it doesn't exist
      const profile = await prisma.candidateProfile.create({
        data: { userId: user.id }
      });
      return res.json({
        success: true,
        data: {
          ...profile,
          email: user.email,
          name: user.name
        }
      });
    }

    // Calculate stats from sessions
    const sessions = await prisma.session.findMany({
      where: { candidateId: userId },
      include: {
        submissions: true,
        aiInteractions: true
      }
    });

    const completedSessions = sessions.filter(s => s.status === 'submitted');
    const totalPoints = completedSessions.reduce((sum, s) => {
      const sessionPoints = s.submissions.reduce((subSum, sub) => subSum + sub.score, 0);
      return sum + sessionPoints;
    }, 0);

    // Calculate PromptIQ score (simplified - based on AI interactions)
    const aiInteractions = sessions.flatMap(s => s.aiInteractions);
    const promptIQScore = calculatePromptIQScore(aiInteractions);

    // Get avatar URL - for public buckets, we can use the URL directly
    // According to Supabase docs, profile pictures should use public buckets
    // See: https://supabase.com/docs/guides/storage/buckets/fundamentals
    const avatarUrl = user.candidateProfile.avatar || null;

    // Debug logging to help diagnose image loading issues
    logger.log('📸 Profile avatar URL from database:', avatarUrl);
    logger.log('📸 User ID:', userId);
    logger.log('📸 Profile exists:', !!user.candidateProfile);

    res.json({
      success: true,
      data: {
        ...user.candidateProfile,
        avatar: avatarUrl,
        email: user.email,
        name: user.name,
        assessmentsCompleted: completedSessions.length,
        totalPoints,
        promptIQScore
      }
    });
  } catch (error: any) {
    logger.error('Get candidate profile error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get candidate profile'
    });
  }
});

// Update candidate profile
router.put('/candidate', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const {
      title,
      location,
      bio,
      avatar,
      skills,
      interests,
      targetRole,
      level,
      achievements,
      isPublic,
      onboardingCompleted
    } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== 'candidate') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const updateData: any = {};
    if (title !== undefined) updateData.title = title;
    if (location !== undefined) updateData.location = location;
    if (bio !== undefined) updateData.bio = bio;
    if (avatar !== undefined) {
      updateData.avatar = avatar;
      logger.log('💾 Saving avatar URL to database:', avatar);
      logger.log('💾 User ID:', userId);
    }
    if (skills !== undefined) updateData.skills = skills;
    if (interests !== undefined) updateData.interests = interests;
    if (targetRole !== undefined) updateData.targetRole = targetRole;
    if (level !== undefined) updateData.level = level;
    if (achievements !== undefined) updateData.achievements = achievements;
    if (isPublic !== undefined) updateData.isPublic = isPublic;
    if (onboardingCompleted !== undefined) updateData.onboardingCompleted = onboardingCompleted;

    // Update or create profile
    const profile = await prisma.candidateProfile.upsert({
      where: { userId },
      update: updateData,
      create: {
        userId,
        ...updateData
      }
    });
    
    logger.log('💾 Profile updated successfully. Avatar URL in database:', profile.avatar);

    res.json({
      success: true,
      data: profile
    });
  } catch (error: any) {
    logger.error('Update candidate profile error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update candidate profile'
    });
  }
});

// Complete candidate onboarding
router.post('/candidate/onboarding', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const onboardingData = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== 'candidate') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Update profile with onboarding data
    const profile = await prisma.candidateProfile.upsert({
      where: { userId },
      update: {
        ...onboardingData,
        onboardingCompleted: true
      },
      create: {
        userId,
        ...onboardingData,
        onboardingCompleted: true
      }
    });

    res.json({
      success: true,
      data: profile
    });
  } catch (error: any) {
    logger.error('Candidate onboarding error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to complete onboarding'
    });
  }
});

// Get recruiter profile
router.get('/recruiter', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        recruiterProfile: {
          include: {
            company: true
          }
        }
      }
    });

    if (!user || user.role !== 'recruiter') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Recruiter profile only.'
      });
    }

    if (!user.recruiterProfile) {
      // Create profile if it doesn't exist
      const profile = await prisma.recruiterProfile.create({
        data: { userId: user.id },
        include: { company: true }
      });
      return res.json({
        success: true,
        data: {
          ...profile,
          email: user.email,
          name: user.name,
          company: profile.company
        }
      });
    }

    // Get avatar URL - for public buckets, we can use the URL directly
    // For private buckets, we'd refresh with signed URL, but based on Supabase docs,
    // profile pictures should use public buckets for better performance
    const avatarUrl = user.recruiterProfile.avatar || null;

    res.json({
      success: true,
      data: {
        ...user.recruiterProfile,
        avatar: avatarUrl,
        email: user.email,
        name: user.name,
        company: user.recruiterProfile.company
      }
    });
  } catch (error: any) {
    logger.error('Get recruiter profile error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get recruiter profile'
    });
  }
});

// Update recruiter profile
router.put('/recruiter', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const {
      position,
      department,
      avatar,
      companyId,
      company // Full company object for update
    } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== 'recruiter') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    let finalCompanyId = companyId;

    // Update or create company if provided
    if (company) {
      if (company.id) {
        // Update existing company
        await prisma.company.update({
          where: { id: company.id },
          data: {
            name: company.name,
            industry: company.industry,
            size: company.size,
            location: company.location,
            website: company.website,
            description: company.description,
            logo: company.logo
          }
        });
        finalCompanyId = company.id;
      } else {
        // Create new company or find existing
        const existingCompany = await prisma.company.findFirst({
          where: { name: company.name }
        });
        
        if (existingCompany) {
          // Update existing company with new data (including logo)
          await prisma.company.update({
            where: { id: existingCompany.id },
            data: {
              name: company.name,
              industry: company.industry,
              size: company.size,
              location: company.location,
              website: company.website,
              description: company.description,
              logo: company.logo
            }
          });
          finalCompanyId = existingCompany.id;
        } else {
          const newCompany = await prisma.company.create({
            data: {
              name: company.name,
              industry: company.industry,
              size: company.size,
              location: company.location,
              website: company.website,
              description: company.description,
              logo: company.logo
            }
          });
          finalCompanyId = newCompany.id;
        }
      }
    }

    const updateData: any = {};
    if (position !== undefined) updateData.position = position;
    if (department !== undefined) updateData.department = department;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (finalCompanyId !== undefined) updateData.companyId = finalCompanyId;
    if (req.body.onboardingCompleted !== undefined) updateData.onboardingCompleted = req.body.onboardingCompleted;

    // Update or create profile
    const profile = await prisma.recruiterProfile.upsert({
      where: { userId },
      update: updateData,
      create: {
        userId,
        ...updateData
      },
      include: {
        company: true
      }
    });

    res.json({
      success: true,
      data: {
        ...profile,
        company: profile.company
      }
    });
  } catch (error: any) {
    logger.error('Update recruiter profile error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update recruiter profile'
    });
  }
});

// Complete recruiter onboarding
router.post('/recruiter/onboarding', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { position, department, company } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== 'recruiter') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    let companyId = null;

    // Create or find company
    if (company) {
      const existingCompany = await prisma.company.findFirst({
        where: { name: company.name }
      });
      
      if (existingCompany) {
        companyId = existingCompany.id;
      } else {
        const newCompany = await prisma.company.create({
          data: {
            name: company.name,
            industry: company.industry,
            size: company.size,
            location: company.location,
            website: company.website,
            description: company.description,
            logo: company.logo
          }
        });
        companyId = newCompany.id;
      }
    }

    // Update profile with onboarding data
    const profile = await prisma.recruiterProfile.upsert({
      where: { userId },
      update: {
        position,
        department,
        companyId,
        onboardingCompleted: true
      },
      create: {
        userId,
        position,
        department,
        companyId,
        onboardingCompleted: true
      },
      include: {
        company: true
      }
    });

    res.json({
      success: true,
      data: {
        ...profile,
        company: profile.company
      }
    });
  } catch (error: any) {
    logger.error('Recruiter onboarding error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to complete onboarding'
    });
  }
});

// Helper function to calculate PromptIQ score
function calculatePromptIQScore(interactions: any[]): number {
  if (interactions.length === 0) return 0;

  let score = 100;
  const prompts = interactions.filter(i => i.eventType === 'prompt_sent');
  const copies = interactions.filter(i => i.eventType === 'code_copied_from_ai');

  // Deduct for excessive copying
  if (copies.length > prompts.length * 0.5) {
    score -= 20;
  }

  // Deduct for solution requests
  const solutionRequests = prompts.filter((p: any) => {
    const text = (p.promptText || '').toLowerCase();
    return /solve.*entire|complete.*solution|write.*whole|do.*this.*for.*me/.test(text);
  }).length;

  score -= solutionRequests * 5;

  // Add points for good prompts
  const goodPrompts = prompts.filter((p: any) => {
    const text = (p.promptText || '').toLowerCase();
    return /explain|how.*work|what.*is|help.*understand/.test(text) && text.length > 50;
  }).length;

  score += goodPrompts * 2;

  return Math.max(0, Math.min(100, score));
}

export default router;

