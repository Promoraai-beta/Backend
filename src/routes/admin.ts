import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/rbac';
import { apiLimiter } from '../middleware/rate-limiter';
import * as crypto from 'crypto';
import { logger } from '../lib/logger';

const router = Router();

/**
 * GET /api/admin/stats
 * Get admin dashboard statistics
 */
router.get('/stats', apiLimiter, authenticate, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    // Get user counts
    const candidateCount = await prisma.user.count({
      where: { role: 'candidate' }
    });

    const recruiterCount = await prisma.user.count({
      where: { role: 'recruiter' }
    });

    const adminCount = await prisma.user.count({
      where: { role: 'admin' }
    });

    // Get profile completion counts
    const candidatesWithProfiles = await prisma.candidateProfile.count({
      where: { onboardingCompleted: true }
    });

    const recruitersWithProfiles = await prisma.recruiterProfile.count({
      where: { onboardingCompleted: true }
    });

    // Get session statistics
    const totalSessions = await prisma.session.count();
    const activeSessions = await prisma.session.count({
      where: { status: 'active' }
    });
    const completedSessions = await prisma.session.count({
      where: { status: 'submitted' }
    });

    // Get assessment statistics
    const totalAssessments = await prisma.assessment.count();
    const assessmentsThisMonth = await prisma.assessment.count({
      where: {
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        }
      }
    });

    // Get company statistics
    const totalCompanies = await prisma.company.count();

    // Get invitation statistics
    const totalInvitations = await prisma.invitation.count();
    const usedInvitations = await prisma.invitation.count({
      where: { usedAt: { not: null } }
    });
    const pendingInvitations = await prisma.invitation.count({
      where: { usedAt: null }
    });

    // Get recent activity (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentUsers = await prisma.user.count({
      where: {
        createdAt: {
          gte: sevenDaysAgo
        }
      }
    });

    const recentSessions = await prisma.session.count({
      where: {
        createdAt: {
          gte: sevenDaysAgo
        }
      }
    });

    res.json({
      success: true,
      data: {
        users: {
          total: candidateCount + recruiterCount + adminCount,
          candidates: candidateCount,
          recruiters: recruiterCount,
          admins: adminCount,
          candidatesOnboarded: candidatesWithProfiles,
          recruitersOnboarded: recruitersWithProfiles
        },
        sessions: {
          total: totalSessions,
          active: activeSessions,
          completed: completedSessions,
          recent: recentSessions
        },
        assessments: {
          total: totalAssessments,
          thisMonth: assessmentsThisMonth
        },
        companies: {
          total: totalCompanies
        },
        invitations: {
          total: totalInvitations,
          used: usedInvitations,
          pending: pendingInvitations
        },
        activity: {
          recentUsers,
          recentSessions
        }
      }
    });
  } catch (error: any) {
    logger.error('Get admin stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get admin statistics'
    });
  }
});

/**
 * GET /api/admin/users
 * Get all users with pagination
 */
router.get('/users', apiLimiter, authenticate, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const role = req.query.role as string;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (role) {
      where.role = role;
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        include: {
          candidateProfile: true,
          recruiterProfile: {
            include: {
              company: true
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        }
      }),
      prisma.user.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error: any) {
    logger.error('Get admin users error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get users'
    });
  }
});

/**
 * POST /api/admin/invitations
 * Create invitation (admin can create without restrictions)
 */
router.post('/invitations', apiLimiter, authenticate, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { email, companyId, companyName, expiresInDays } = req.body;
    const createdBy = (req as any).userId;

    // Generate unique token
    const token = crypto.randomBytes(32).toString('hex');

    // Calculate expiry date (default 30 days)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (expiresInDays || 30));

    // Validate company
    let finalCompanyId = companyId || null;
    if (companyName && !companyId) {
      const existingCompany = await prisma.company.findFirst({
        where: { name: companyName }
      });

      if (existingCompany) {
        finalCompanyId = existingCompany.id;
      }
    }

    // Create invitation
    const invitation = await prisma.invitation.create({
      data: {
        token,
        email: email || null,
        companyId: finalCompanyId,
        companyName: companyName || null,
        role: 'recruiter',
        expiresAt,
        createdBy: createdBy || null
      },
      include: {
        company: true
      }
    });

    // Generate invitation URL
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const invitationUrl = `${frontendUrl}/invite/${token}`;

    res.json({
      success: true,
      data: {
        invitation: {
          id: invitation.id,
          token: invitation.token,
          email: invitation.email,
          companyName: invitation.companyName || invitation.company?.name,
          expiresAt: invitation.expiresAt,
          invitationUrl
        }
      }
    });
  } catch (error: any) {
    logger.error('Create invitation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create invitation'
    });
  }
});

/**
 * GET /api/admin/invitations
 * Get all invitations
 */
router.get('/invitations', apiLimiter, authenticate, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const invitations = await prisma.invitation.findMany({
      include: {
        company: true
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 100
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const invitationsWithUrls = invitations.map(inv => ({
      ...inv,
      invitationUrl: `${frontendUrl}/invite/${inv.token}`
    }));

    res.json({
      success: true,
      data: invitationsWithUrls
    });
  } catch (error: any) {
    logger.error('Get invitations error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get invitations'
    });
  }
});

export default router;

