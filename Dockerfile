# Backend Dockerfile for Promora Assessment Platform
# Multi-stage build for optimized production image

# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL in builder stage so Prisma can detect correct version
RUN apk add --no-cache openssl openssl-dev libc6-compat

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (including dev dependencies for build)
RUN npm ci

# Copy Prisma schema
COPY prisma ./prisma

# Generate Prisma Client
# OpenSSL is installed above, and binaryTargets in schema.prisma will ensure correct binaries are generated
RUN npx prisma generate

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Stage 2: Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL and other required libraries for Prisma
# For Alpine, we need openssl and libc6-compat for Prisma
RUN apk add --no-cache openssl openssl-dev libc6-compat

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy Prisma files and generated client
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Copy built JavaScript files
COPY --from=builder /app/dist ./dist

# Create uploads directory for video files
RUN mkdir -p uploads/videos uploads/hls

# Install Docker CLI (for docker exec into MCP containers)
# Note: We need docker CLI but not the daemon (we use host's Docker socket)
RUN apk add --no-cache docker-cli

# Create non-root user for security
# Note: User needs access to Docker socket (handled via volume mount)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Add nodejs user to docker group (if group exists in container)
# Docker socket permissions are handled by volume mount
USER nodejs

# Expose port
EXPOSE 5001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "dist/server.js"]
