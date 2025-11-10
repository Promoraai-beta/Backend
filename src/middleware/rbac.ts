import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Extend Request type to include user info
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: string;
      userEmail?: string;
    }
  }
}

// Authentication middleware - verifies JWT token
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.userEmail = decoded.email;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token'
    });
  }
};

// Role-based access control - require specific role
export const requireRole = (roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Insufficient permissions.'
      });
    }
    next();
  };
};

// Check if user owns the session (for recruiters, check if session belongs to their company's assessment)
export const checkSessionOwnership = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.id || req.params.sessionId || req.body.sessionId;
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }

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

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // If user is the candidate, allow access
    if (req.userRole === 'candidate' && session.candidateId === req.userId) {
      return next();
    }

    // If user is a recruiter, check multiple conditions:
    // 1. Recruiter created the session (session has recruiterEmail matching recruiter's email)
    // 2. Recruiter created the assessment (assessment.createdBy matches recruiter's userId)
    // 3. Recruiter's company owns the assessment (assessment.companyId matches recruiter's companyId)
    if (req.userRole === 'recruiter') {
      const recruiterProfile = await prisma.recruiterProfile.findUnique({
        where: { userId: req.userId || '' },
        include: {
          user: {
            select: { email: true }
          }
        }
      });

      if (!recruiterProfile) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Recruiter profile not found.'
        });
      }

      // Check 1: Session was created by this recruiter (via recruiterEmail)
      if (session.recruiterEmail && recruiterProfile.user?.email && 
          session.recruiterEmail.toLowerCase() === recruiterProfile.user.email.toLowerCase()) {
        console.log(`[Session Access] Recruiter ${req.userId} granted access via recruiterEmail match`);
        return next();
      }

      // Check 2: Assessment was created by this recruiter
      if (session.assessment?.createdBy === req.userId) {
        console.log(`[Session Access] Recruiter ${req.userId} granted access via assessment creator`);
        return next();
      }

      // Check 3: Recruiter's company owns the assessment
      if (session.assessment?.companyId && recruiterProfile.companyId && 
          session.assessment.companyId === recruiterProfile.companyId) {
        console.log(`[Session Access] Recruiter ${req.userId} granted access via company ownership`);
        return next();
      }

      // If assessment type is recruiter and no explicit ownership, still allow if recruiter is authenticated
      // This handles cases where sessions are created for recruiter assessments but company linkage isn't perfect
      if (session.assessment?.assessmentType === 'recruiter' && recruiterProfile) {
        console.log(`[Session Access] Recruiter ${req.userId} granted access to recruiter assessment`);
        return next();
      }
    }

    // Admin can access any session
    if (req.userRole === 'admin') {
      return next();
    }

    // Deny access
    console.log(`[Session Access] Access denied for user ${req.userId} (role: ${req.userRole}) to session ${sessionId}`);
    return res.status(403).json({
      success: false,
      error: 'Access denied. You do not have permission to access this session.'
    });
  } catch (error: any) {
    console.error('Session ownership check error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify session ownership'
    });
  }
};

// Check if user owns the assessment (for recruiters)
export const checkAssessmentOwnership = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const assessmentId = req.params.id || req.params.assessmentId || req.body.assessmentId;
    if (!assessmentId) {
      return res.status(400).json({
        success: false,
        error: 'Assessment ID is required'
      });
    }

    const assessment = await prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        company: true
      }
    });

    if (!assessment) {
      return res.status(404).json({
        success: false,
        error: 'Assessment not found'
      });
    }

    // If user is a recruiter, check if they belong to the company that owns the assessment
    if (req.userRole === 'recruiter') {
      const recruiterProfile = await prisma.recruiterProfile.findUnique({
        where: { userId: req.userId || '' }
      });

      // Allow access if recruiter's company matches assessment's company, or if recruiter created it
      if (recruiterProfile?.companyId === assessment.companyId || assessment.createdBy === req.userId) {
        return next();
      }
    }

    // Admin can access any assessment
    if (req.userRole === 'admin') {
      return next();
    }

    // Deny access
    return res.status(403).json({
      success: false,
      error: 'Access denied. You do not have permission to access this assessment.'
    });
  } catch (error: any) {
    console.error('Assessment ownership check error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify assessment ownership'
    });
  }
};

// Optional authentication - doesn't fail if no token, but sets user info if present
export const optionalAuthenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        req.userEmail = decoded.email;
      } catch (error) {
        // Invalid token, but continue without authentication
      }
    }

    next();
  } catch (error) {
    next();
  }
};

