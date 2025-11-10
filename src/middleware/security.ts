import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

// Security headers middleware
export const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
  // Skip security headers for OPTIONS requests (CORS preflight)
  if (req.method === 'OPTIONS') {
    return next();
  }
  
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Strict Transport Security (HTTPS only)
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  // Content Security Policy - relaxed for API endpoints to allow cross-origin requests
  if (req.path.startsWith('/api')) {
    // More permissive CSP for API endpoints
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self' *; script-src 'self' 'unsafe-inline' 'unsafe-eval' *; style-src 'self' 'unsafe-inline' *;"
    );
  } else {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
    );
  }
  
  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  next();
};

// Session code security - track failed attempts and implement lockouts
const sessionCodeAttempts = new Map<string, { count: number; lockedUntil: number }>();

export const validateSessionCodeSecurity = async (req: Request, res: Response, next: NextFunction) => {
  const code = req.params.code;
  const clientIp = Array.isArray(req.headers['x-forwarded-for']) 
    ? req.headers['x-forwarded-for'][0] 
    : (req.headers['x-forwarded-for'] || req.ip || 'unknown');

  if (!code || typeof code !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Session code is required'
    });
  }

  // Check if this IP is locked out
  const attemptData = sessionCodeAttempts.get(clientIp);
  if (attemptData && attemptData.lockedUntil > Date.now()) {
    return res.status(429).json({
      success: false,
      error: 'Too many failed attempts. Please try again later.'
    });
  }

  // Validate session code format (8+ alphanumeric characters)
  if (!/^[A-Z0-9]{8,}$/.test(code.toUpperCase())) {
    // Increment failed attempts
    if (!attemptData) {
      sessionCodeAttempts.set(clientIp, { count: 1, lockedUntil: 0 });
    } else {
      attemptData.count++;
      if (attemptData.count >= 5) {
        // Lock for 15 minutes after 5 failed attempts
        attemptData.lockedUntil = Date.now() + 15 * 60 * 1000;
      }
    }

    return res.status(400).json({
      success: false,
      error: 'Invalid session code format'
    });
  }

  // Check if session exists and is not expired
  try {
    const session = await prisma.session.findUnique({
      where: { sessionCode: code.toUpperCase() }
    });

    if (!session) {
      // Increment failed attempts
      const currentAttemptData = sessionCodeAttempts.get(clientIp);
      if (!currentAttemptData) {
        sessionCodeAttempts.set(clientIp, { count: 1, lockedUntil: 0 });
      } else {
        currentAttemptData.count++;
        if (currentAttemptData.count >= 5) {
          currentAttemptData.lockedUntil = Date.now() + 15 * 60 * 1000;
        }
      }

      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Check if session is expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Session has expired'
      });
    }

    // Clear failed attempts on successful validation
    sessionCodeAttempts.delete(clientIp);

    // Attach session to request for use in route handlers
    (req as any).session = session;
    next();
  } catch (error: any) {
    logger.error('Session validation error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to validate session'
    });
  }
};

// Clean up old session code attempt records (run periodically)
setInterval(() => {
  const now = Date.now();
  const entries = Array.from(sessionCodeAttempts.entries());
  for (const [ip, data] of entries) {
    if (data.lockedUntil < now && data.count === 0) {
      sessionCodeAttempts.delete(ip);
    }
  }
}, 60 * 1000); // Clean up every minute

// Server-side timer enforcement
export const enforceTimer = async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.id || req.body.sessionId;

  if (!sessionId) {
    return next(); // Skip if no session ID
  }

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId }
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Check if session has expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      // Auto-end expired sessions (mark as 'ended', not 'submitted')
      if (session.status === 'active') {
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            status: 'ended',
            submittedAt: new Date()
          }
        });
      }

      return res.status(400).json({
        success: false,
        error: 'Session has expired',
        expired: true
      });
    }

    // Check if time limit has been exceeded
    if (session.startedAt && session.timeLimit) {
      const elapsed = (Date.now() - new Date(session.startedAt).getTime()) / 1000;
      if (elapsed > session.timeLimit) {
        // Auto-end sessions that exceeded time limit (mark as 'ended', not 'submitted')
        if (session.status === 'active') {
          await prisma.session.update({
            where: { id: sessionId },
            data: {
              status: 'ended',
              submittedAt: new Date()
            }
          });
        }

        return res.status(400).json({
          success: false,
          error: 'Time limit exceeded',
          timeExceeded: true
        });
      }
    }

    next();
  } catch (error: any) {
    logger.error('Timer enforcement error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to enforce timer'
    });
  }
};

