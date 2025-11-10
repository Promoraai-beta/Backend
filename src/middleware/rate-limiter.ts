import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';

// General API rate limiter
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests, please try again later.'
    });
  }
});

// Strict rate limiter for authentication endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login/register attempts per windowMs
  message: 'Too many authentication attempts, please try again later.',
  skipSuccessfulRequests: true, // Don't count successful requests
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'Too many authentication attempts, please try again in 15 minutes.'
    });
  }
});

// Rate limiter for session code validation (prevent brute force)
// Note: This should be lenient enough for legitimate use but strict enough to prevent abuse
export const sessionCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 session code attempts per windowMs (increased from 10)
  skipSuccessfulRequests: true, // Don't count successful requests (only count failures)
  message: 'Too many session code attempts, please try again later.',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    // Rate limit window is 15 minutes
    const windowMinutes = 15;
    const retryAfterSeconds = windowMinutes * 60;
    
    res.status(429).json({
      success: false,
      error: 'Too many session code attempts. Please try again later.',
      retryAfter: retryAfterSeconds, // Seconds until limit resets (15 minutes)
      retryAfterMinutes: windowMinutes,
      message: `Rate limit exceeded. Please wait ${windowMinutes} minutes before trying again. The limit will reset automatically.`
    });
  }
});

// Rate limiter for code execution (prevent abuse)
export const executeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 executions per minute
  message: 'Too many code executions, please slow down.',
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'Too many code executions. Please wait a moment before running again.'
    });
  }
});

// Rate limiter for live monitoring (reduce server load)
export const liveMonitoringLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // Limit each IP to 20 requests per minute (effectively 3s interval)
  message: 'Too many monitoring requests.',
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'Too many monitoring requests. Please reduce polling frequency.'
    });
  }
});

// Rate limiter for video uploads
export const videoUploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 uploads per minute (1 per second)
  message: 'Too many video uploads.',
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'Too many video uploads. Please slow down.'
    });
  }
});

// Rate limiter for AI interactions tracking
export const aiInteractionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 AI interaction events per minute
  message: 'Too many AI interaction events.',
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'Too many AI interaction events. Please slow down.'
    });
  }
});

// Rate limiter for code saves (debouncing at middleware level)
export const codeSaveLimiter = rateLimit({
  windowMs: 5 * 1000, // 5 seconds
  max: 2, // Limit each IP to 2 saves per 5 seconds (debouncing)
  message: 'Code save rate limit exceeded.',
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'Code save rate limit exceeded. Please wait a moment.'
    });
  }
});

