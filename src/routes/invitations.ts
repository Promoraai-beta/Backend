import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { authenticate, requireRole } from '../middleware/rbac';
import { apiLimiter } from '../middleware/rate-limiter';
import { logger } from '../lib/logger';

const router = Router();

/**
 * POST /api/invitations
 * Create a new recruiter invitation (admin only)
 * Requires authentication and admin role
 */
router.post('/', apiLimiter, authenticate, requireRole(['recruiter']), async (req: Request, res: Response) => {
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
      // Create company if it doesn't exist
      const existingCompany = await prisma.company.findFirst({
        where: { name: companyName }
      });

      if (existingCompany) {
        finalCompanyId = existingCompany.id;
      } else {
        // Will be created when invitation is used
        finalCompanyId = null;
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
 * GET /api/invitations/:token
 * Get invitation details (public endpoint)
 */
router.get('/:token', apiLimiter, async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    const invitation = await prisma.invitation.findUnique({
      where: { token },
      include: {
        company: true
      }
    });

    if (!invitation) {
      return res.status(404).json({
        success: false,
        error: 'Invitation not found'
      });
    }

    // Check if invitation is used
    if (invitation.usedAt) {
      return res.status(400).json({
        success: false,
        error: 'This invitation has already been used'
      });
    }

    // Check if invitation is expired
    if (invitation.expiresAt && new Date() > invitation.expiresAt) {
      return res.status(400).json({
        success: false,
        error: 'This invitation has expired'
      });
    }

    res.json({
      success: true,
      data: {
        token: invitation.token,
        email: invitation.email,
        companyName: invitation.companyName || invitation.company?.name,
        companyId: invitation.companyId,
        expiresAt: invitation.expiresAt
      }
    });
  } catch (error: any) {
    logger.error('Get invitation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get invitation'
    });
  }
});

/**
 * POST /api/invitations/:token/accept
 * Accept invitation and create recruiter account
 */
router.post('/:token/accept', apiLimiter, async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { email, password, name, company } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, and name are required'
      });
    }

    // Get invitation
    const invitation = await prisma.invitation.findUnique({
      where: { token },
      include: {
        company: true
      }
    });

    if (!invitation) {
      return res.status(404).json({
        success: false,
        error: 'Invitation not found'
      });
    }

    // Check if invitation is used
    if (invitation.usedAt) {
      return res.status(400).json({
        success: false,
        error: 'This invitation has already been used'
      });
    }

    // Check if invitation is expired
    if (invitation.expiresAt && new Date() > invitation.expiresAt) {
      return res.status(400).json({
        success: false,
        error: 'This invitation has expired'
      });
    }

    // Check if email matches (if invitation has specific email)
    if (invitation.email && invitation.email !== email) {
      return res.status(400).json({
        success: false,
        error: 'This invitation is for a different email address'
      });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'User with this email already exists'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user and profile in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create user
      const user = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          role: 'recruiter'
        }
      });

      // Determine company ID
      let companyId = invitation.companyId;
      const finalCompanyName = company || invitation.companyName || invitation.company?.name || 'Your Company';

      if (!companyId && finalCompanyName) {
        // Create company if it doesn't exist
        const existingCompany = await tx.company.findFirst({
          where: { name: finalCompanyName }
        });

        if (existingCompany) {
          companyId = existingCompany.id;
        } else {
          const newCompany = await tx.company.create({
            data: { name: finalCompanyName }
          });
          companyId = newCompany.id;
        }
      }

      // Create recruiter profile
      await tx.recruiterProfile.create({
        data: {
          userId: user.id,
          companyId
        }
      });

      // Mark invitation as used
      await tx.invitation.update({
        where: { id: invitation.id },
        data: {
          usedBy: user.id,
          usedAt: new Date()
        }
      });

      return user;
    });

          // Get recruiter profile to check onboarding status
          const recruiterProfile = await prisma.recruiterProfile.findUnique({
            where: { userId: result.id }
          });

          // Generate JWT token
          const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
          const tokenJWT = jwt.sign(
            { userId: result.id, email: result.email, role: result.role },
            JWT_SECRET,
            { expiresIn: '7d' }
          );

          res.json({
            success: true,
            data: {
              user: {
                id: result.id,
                email: result.email,
                name: result.name,
                role: result.role,
                onboardingCompleted: recruiterProfile?.onboardingCompleted || false
              },
              token: tokenJWT
            }
          });
  } catch (error: any) {
    logger.error('Accept invitation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to accept invitation'
    });
  }
});

export default router;

