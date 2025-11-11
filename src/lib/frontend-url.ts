/**
 * Frontend URL Helper
 * Ensures FRONTEND_URL is properly configured and provides a safe way to get it
 */

import { logger } from './logger';

let cachedFrontendUrl: string | null = null;
let warningLogged = false;

/**
 * Get the frontend URL from environment variables
 * In production, FRONTEND_URL must be set
 * In development, falls back to localhost:3000
 */
export function getFrontendUrl(): string {
  // Return cached URL if available
  if (cachedFrontendUrl !== null) {
    return cachedFrontendUrl;
  }

  const frontendUrl = process.env.FRONTEND_URL;

  if (!frontendUrl) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('❌ FRONTEND_URL is required in production. Please set it in environment variables.');
      throw new Error('FRONTEND_URL environment variable is required in production');
    }
    
    // Development fallback
    if (!warningLogged) {
      logger.warn('⚠️ FRONTEND_URL not set, using development fallback: http://localhost:3000');
      logger.warn('⚠️ Set FRONTEND_URL in .env for production deployments');
      warningLogged = true;
    }
    cachedFrontendUrl = 'http://localhost:3000';
    return cachedFrontendUrl;
  }

  // Validate URL format
  try {
    new URL(frontendUrl);
    cachedFrontendUrl = frontendUrl;
    return cachedFrontendUrl;
  } catch (error) {
    logger.error('❌ Invalid FRONTEND_URL format:', frontendUrl);
    throw new Error('FRONTEND_URL must be a valid URL (e.g., https://promora.ai)');
  }
}

