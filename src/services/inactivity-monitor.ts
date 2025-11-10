import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';

// Configuration
const INACTIVITY_TIMEOUT_MS = parseInt(process.env.INACTIVITY_TIMEOUT_MS || '900000', 10); // 15 minutes default
const CHECK_INTERVAL_MS = parseInt(process.env.INACTIVITY_CHECK_INTERVAL_MS || '60000', 10); // Check every minute

// Error tracking to prevent log spam
let lastErrorTime = 0;
let consecutiveErrors = 0;
let lastErrorMessage = '';
const ERROR_LOG_INTERVAL_MS = 300000; // Only log errors every 5 minutes
const MAX_CONSECUTIVE_ERRORS = 5; // Stop checking after 5 consecutive errors

/**
 * Monitor active sessions for inactivity and auto-end sessions that exceed timeout
 */
export async function checkInactiveSessions() {
  try {
    // Check if we've had too many consecutive errors
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      // Silently skip - database is likely down
      return { checked: 0, ended: 0, skipped: true };
    }

    const now = new Date();
    const timeoutThreshold = new Date(now.getTime() - INACTIVITY_TIMEOUT_MS);

    // Find active sessions that haven't had activity in the last 15 minutes
    const inactiveSessions = await prisma.session.findMany({
      where: {
        status: 'active',
        OR: [
          // Session has lastActivityAt and it's older than timeout
          {
            lastActivityAt: {
              lt: timeoutThreshold
            }
          },
          // Session has startedAt but no lastActivityAt and startedAt is older than timeout
          {
            startedAt: {
              lt: timeoutThreshold
            },
            lastActivityAt: null
          }
        ]
      },
      select: {
        id: true,
        sessionCode: true,
        lastActivityAt: true,
        startedAt: true
      }
    });

    // Reset error counter on success
    consecutiveErrors = 0;
    lastErrorTime = 0;
    lastErrorMessage = '';

    if (inactiveSessions.length === 0) {
      return { checked: 0, ended: 0 };
    }

    console.log(`[Inactivity Monitor] Found ${inactiveSessions.length} inactive sessions`);

    // End all inactive sessions
    const endedSessions = await prisma.session.updateMany({
      where: {
        id: {
          in: inactiveSessions.map(s => s.id)
        },
        status: 'active'
      },
      data: {
        status: 'ended',
        submittedAt: now
      }
    });

    console.log(`[Inactivity Monitor] Ended ${endedSessions.count} inactive sessions`);

    // Log details for each ended session
    inactiveSessions.forEach(session => {
      const lastActivity = session.lastActivityAt || session.startedAt;
      const inactiveDuration = lastActivity 
        ? Math.round((now.getTime() - lastActivity.getTime()) / 1000 / 60) 
        : 0;
      console.log(`[Inactivity Monitor] Ended session ${session.sessionCode} (inactive for ${inactiveDuration} minutes)`);
    });

    return { checked: inactiveSessions.length, ended: endedSessions.count };
  } catch (error) {
    consecutiveErrors++;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'UNKNOWN';
    
    // Check if this is a database connection error
    const isConnectionError = 
      errorCode === 'P1001' || // Can't reach database server
      errorCode === 'P2024' || // Connection pool timeout
      errorMessage.includes('Can\'t reach database server') ||
      errorMessage.includes('connection pool');

    // Only log errors:
    // 1. If it's been more than ERROR_LOG_INTERVAL_MS since last log
    // 2. If the error message has changed
    // 3. If we haven't logged this error before
    const now = Date.now();
    const shouldLog = 
      (now - lastErrorTime > ERROR_LOG_INTERVAL_MS) ||
      (errorMessage !== lastErrorMessage) ||
      (consecutiveErrors === 1);

    if (shouldLog) {
      if (isConnectionError) {
        console.error(`[Inactivity Monitor] Database connection error (${errorCode}): Database unreachable. Skipping inactivity checks.`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`[Inactivity Monitor] Too many consecutive errors (${consecutiveErrors}). Pausing inactivity checks until database is available.`);
        }
      } else {
        console.error(`[Inactivity Monitor] Error checking inactive sessions (${errorCode}):`, errorMessage);
      }
      lastErrorTime = now;
      lastErrorMessage = errorMessage;
    }

    // If too many consecutive errors, stop checking (database is likely down)
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      return { checked: 0, ended: 0, skipped: true, error: 'Database unavailable' };
    }

    return { checked: 0, ended: 0, error: errorMessage };
  }
}

/**
 * Start the inactivity monitoring service
 * Runs periodically to check and end inactive sessions
 */
export function startInactivityMonitor() {
  console.log(`[Inactivity Monitor] Starting inactivity monitor (timeout: ${INACTIVITY_TIMEOUT_MS / 1000 / 60} minutes, check interval: ${CHECK_INTERVAL_MS / 1000} seconds)`);

  // Run immediately on startup (but don't log errors - they're handled in checkInactiveSessions)
  checkInactiveSessions().catch(() => {
    // Errors are handled and logged inside checkInactiveSessions
    // This catch just prevents unhandled promise rejections
  });

  // Then run periodically
  const intervalId = setInterval(() => {
    checkInactiveSessions().catch(() => {
      // Errors are handled and logged inside checkInactiveSessions
      // This catch just prevents unhandled promise rejections
    });
  }, CHECK_INTERVAL_MS);

  // Return cleanup function
  return () => {
    clearInterval(intervalId);
    console.log('[Inactivity Monitor] Stopped');
  };
}

/**
 * Check if a session should be ended due to inactivity
 * Used for real-time checks before allowing session access
 */
export async function checkSessionInactivity(sessionId: string): Promise<{ inactive: boolean; reason?: string }> {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        lastActivityAt: true,
        startedAt: true
      }
    });

    if (!session || session.status !== 'active') {
      return { inactive: false };
    }

    const now = new Date();
    const timeoutThreshold = new Date(now.getTime() - INACTIVITY_TIMEOUT_MS);
    const lastActivity = session.lastActivityAt || session.startedAt;

    if (!lastActivity) {
      // Session started but no activity recorded - use startedAt
      if (session.startedAt && session.startedAt < timeoutThreshold) {
        return { inactive: true, reason: 'inactivity_timeout' };
      }
      return { inactive: false };
    }

    if (lastActivity < timeoutThreshold) {
      // Session is inactive - end it
      await prisma.session.update({
        where: { id: sessionId },
        data: {
          status: 'ended',
          submittedAt: now
        }
      });

      return { inactive: true, reason: 'inactivity_timeout' };
    }

    return { inactive: false };
  } catch (error) {
    // Don't log errors here - they're likely database connection issues
    // Just return inactive: false to allow session to continue
    // The periodic check will handle inactivity monitoring when DB is available
    const errorCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'UNKNOWN';
    if (errorCode === 'P1001' || errorCode === 'P2024') {
      // Database connection error - skip inactivity check for now
      return { inactive: false };
    }
    // For other errors, also skip (don't block session access due to DB issues)
    return { inactive: false };
  }
}

