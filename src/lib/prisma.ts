/**
 * Prisma Client Singleton
 * Prevents multiple instances in development
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma connection pool configuration
// Connection pool settings can be configured via DATABASE_URL query parameters:
// DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=20&pool_timeout=20&connect_timeout=10"
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
      ? ['query', 'error', 'warn'] 
      : ['error'], // Only log errors in production
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Handle process exit to disconnect Prisma gracefully
const cleanup = async () => {
  try {
    await prisma.$disconnect();
  } catch (error) {
    // Ignore disconnect errors
  }
};

process.on('beforeExit', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
