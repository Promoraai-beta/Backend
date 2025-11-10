import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authLimiter } from '../middleware/rate-limiter';
import { validateEmail, validatePassword, handleValidationErrors } from '../middleware/validation';

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
      console.warn('⚠️ WARNING: JWT_SECRET not set, using development fallback. Set JWT_SECRET in .env for production!');
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
    console.error('❌ CRITICAL: JWT_SECRET environment variable is not set!');
    console.error('   Please set JWT_SECRET in your .env file.');
    console.error('   Authentication will not work without this secret.');
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
    console.error('Register error:', error);
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
    console.error('Login error:', error);
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
    console.error('Get me error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get user'
    });
  }
});

export default router;

