import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { authLimiter } from '../middleware/rate-limiter';
import { validateEmail, validatePassword, handleValidationErrors } from '../middleware/validation';
import { sendEmail, generatePasswordResetEmail } from '../lib/email';

const router = Router();

// JWT_SECRET must be set in environment variables for security
// In production, this should never have a fallback value
const JWT_SECRET = process.env.JWT_SECRET;

// Cache the secret and warning flag to avoid repeated warnings
let cachedSecret: string | null = null;
let warningLogged = false;

// Type guard: ensure JWT_SECRET is defined for TypeScript
// In development, use a fallback only if not set (for local testing)
const getJwtSecret = (): string => {
  // Return cached secret if available
  if (cachedSecret !== null) {
    return cachedSecret;
  }

  if (!JWT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is required in production. Please set it in environment variables.');
    }
    
    // Development fallback (should be set in .env but allow local testing)
    // Only log warning once to avoid spam
    if (!warningLogged) {
      logger.warn('⚠️ WARNING: JWT_SECRET not set, using development fallback. Set JWT_SECRET in .env for production!');
      warningLogged = true;
    }
    cachedSecret = 'development-secret-key-change-in-production';
    return cachedSecret;
  }

  cachedSecret = JWT_SECRET;
  return cachedSecret;
};

// Log warning/error only once at module load (not on every request)
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    logger.error('❌ CRITICAL: JWT_SECRET environment variable is not set!');
    logger.error('   Please set JWT_SECRET in your .env file.');
    logger.error('   Authentication will not work without this secret.');
    // Don't throw here - let getJwtSecret handle it to avoid startup failure
    // The function will throw when called, which is more graceful
  } else {
    // In development, just warn once (getJwtSecret will handle the actual warning)
    // This prevents duplicate warnings
  }
}

// Register new user (CANDIDATES ONLY - recruiters must use invitation links)
router.post('/register', authLimiter, validateEmail, validatePassword, handleValidationErrors, async (req: Request, res: Response) => {
  try {
    const { email, password, name, role, company } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, and name are required'
      });
    }

    // Only allow candidate registration publicly
    // Recruiters must use invitation links
    if (role && role !== 'candidate') {
      return res.status(403).json({
        success: false,
        error: 'Recruiter registration is invitation-only. Please use an invitation link to sign up as a recruiter.'
      });
    }

    // Force role to candidate for public registration
    const finalRole = 'candidate';

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

    // Create user (always candidate for public registration)
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: finalRole
      }
    });

    // Create candidate profile
    await prisma.candidateProfile.create({
      data: {
        userId: user.id
      }
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role
        },
        token
      }
    });
  } catch (error: any) {
    logger.error('Register error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to register user'
    });
  }
});

// Login user
router.post('/login', authLimiter, validateEmail, handleValidationErrors, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        candidateProfile: true,
        recruiterProfile: {
          include: {
            company: true
          }
        }
      }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          onboardingCompleted: user.role === 'candidate'
            ? user.candidateProfile?.onboardingCompleted || false
            : user.recruiterProfile?.onboardingCompleted || false
        },
        token
      }
    });
  } catch (error: any) {
    logger.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to login'
    });
  }
});

// Get current user (requires authentication)
router.get('/me', async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, getJwtSecret()) as any;

    // Get user with profile
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        candidateProfile: true,
        recruiterProfile: {
          include: {
            company: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get onboarding status
    let onboardingCompleted = false;
    if (user.role === 'candidate') {
      onboardingCompleted = user.candidateProfile?.onboardingCompleted || false;
    } else if (user.role === 'recruiter') {
      onboardingCompleted = user.recruiterProfile?.onboardingCompleted || false;
    } else if (user.role === 'admin') {
      onboardingCompleted = true; // Admins don't need onboarding
    }

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        company: user.recruiterProfile?.company?.name || null,
        onboardingCompleted
      }
    });
  } catch (error: any) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }
    logger.error('Get me error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get user'
    });
  }
});

// Request password reset - send verification code via email
router.post('/forgot-password', authLimiter, validateEmail, handleValidationErrors, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    // Check if user exists (don't reveal if email exists for security)
    const user = await prisma.user.findUnique({
      where: { email }
    });

    logger.log('📧 Forgot password request for:', email);
    logger.log('👤 User exists:', !!user);

    // Always return success to prevent email enumeration
    // But only send email if user exists
    if (user) {
      // Generate 6-digit verification code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Generate secure token for password reset
      const token = crypto.randomBytes(32).toString('hex');
      
      // Set expiration to 15 minutes from now
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 15);

      logger.log('🔑 Generated reset code:', code);
      logger.log('⏰ Code expires at:', expiresAt.toISOString());

      // Invalidate any existing reset requests for this email
      const invalidated = await prisma.passwordReset.updateMany({
        where: {
          email,
          used: false,
          expiresAt: { gt: new Date() }
        },
        data: {
          used: true
        }
      });
      logger.log('🗑️ Invalidated existing requests:', invalidated.count);

      // Create new password reset record
      const resetRecord = await prisma.passwordReset.create({
        data: {
          email,
          code,
          token,
          expiresAt
        }
      });
      logger.log('✅ Created password reset record:', resetRecord.id);

      // Send email with verification code
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const resetUrl = `${frontendUrl}/reset-password?token=${token}`;
      
      const emailOptions = generatePasswordResetEmail(user.email, user.name || 'User', code, resetUrl);
      const emailResult = await sendEmail(emailOptions);
      
      if (!emailResult.success) {
        logger.error('❌ Failed to send password reset email:', emailResult.error);
        logger.error('📧 Email details:', {
          to: user.email,
          code: code,
          error: emailResult.error
        });
        // Log the code for development/debugging (remove in production)
        if (process.env.NODE_ENV === 'development') {
          logger.log('🔑 Password reset code (DEV ONLY):', code);
        }
      } else {
        logger.log('✅ Password reset email sent successfully to:', user.email);
      }
    }

    // Always return success (security best practice)
    res.json({
      success: true,
      message: 'If an account with that email exists, a password reset code has been sent.'
    });
  } catch (error: any) {
    logger.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process password reset request'
    });
  }
});

// Verify reset code
router.post('/verify-reset-code', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body;

    logger.log('🔍 Verifying reset code:', { email, codeLength: code?.length });

    if (!email || !code) {
      logger.log('❌ Missing email or code');
      return res.status(400).json({
        success: false,
        error: 'Email and code are required'
      });
    }

    // Find valid reset request
    const resetRequest = await prisma.passwordReset.findFirst({
      where: {
        email,
        code,
        used: false,
        expiresAt: { gt: new Date() }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (!resetRequest) {
      // Check if code exists but is expired or used
      const anyRequest = await prisma.passwordReset.findFirst({
        where: {
          email,
          code
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      if (anyRequest) {
        if (anyRequest.used) {
          logger.log('❌ Code already used');
          return res.status(400).json({
            success: false,
            error: 'This verification code has already been used. Please request a new password reset.'
          });
        }
        if (new Date() > anyRequest.expiresAt) {
          logger.log('❌ Code expired');
          return res.status(400).json({
            success: false,
            error: 'Verification code has expired. Please request a new password reset.'
          });
        }
      } else {
        logger.log('❌ No reset request found for email:', email);
      }

      return res.status(400).json({
        success: false,
        error: 'Invalid or expired verification code'
      });
    }

    logger.log('✅ Code verified successfully for:', email);

    // Return token for password reset
    res.json({
      success: true,
      data: {
        token: resetRequest.token
      }
    });
  } catch (error: any) {
    logger.error('Verify reset code error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to verify code'
    });
  }
});

// Reset password with new password
router.post('/reset-password', authLimiter, validatePassword, handleValidationErrors, async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        error: 'Token and password are required'
      });
    }

    // Find valid reset request
    const resetRequest = await prisma.passwordReset.findUnique({
      where: {
        token,
        used: false
      }
    });

    if (!resetRequest) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired reset token'
      });
    }

    // Check if token has expired
    if (new Date() > resetRequest.expiresAt) {
      return res.status(400).json({
        success: false,
        error: 'Reset token has expired. Please request a new password reset.'
      });
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email: resetRequest.email }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update password and mark reset as used
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword }
      }),
      prisma.passwordReset.update({
        where: { id: resetRequest.id },
        data: {
          used: true,
          usedAt: new Date()
        }
      })
    ]);

    res.json({
      success: true,
      message: 'Password has been reset successfully'
    });
  } catch (error: any) {
    logger.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reset password'
    });
  }
});

export default router;

