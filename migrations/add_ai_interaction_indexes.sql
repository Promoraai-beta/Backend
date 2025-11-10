-- Migration: Add indexes to ai_interactions table for better query performance
-- These indexes support WebContainer event tracking and MCP agent analysis

-- Index for filtering by session and event type (most common query pattern)
CREATE INDEX IF NOT EXISTS "ai_interactions_sessionId_eventType_idx" 
ON "ai_interactions"("sessionId", "event_type");

-- Index for filtering by session and timestamp (for timeline queries)
CREATE INDEX IF NOT EXISTS "ai_interactions_sessionId_timestamp_idx" 
ON "ai_interactions"("sessionId", "timestamp");

-- Index for filtering by event type (for agent analysis)
CREATE INDEX IF NOT EXISTS "ai_interactions_eventType_idx" 
ON "ai_interactions"("event_type");

-- Index for filtering by timestamp (for time-based queries)
CREATE INDEX IF NOT EXISTS "ai_interactions_timestamp_idx" 
ON "ai_interactions"("timestamp");

-- Note: If you need to rollback, drop these indexes:
-- DROP INDEX IF EXISTS "ai_interactions_sessionId_eventType_idx";
-- DROP INDEX IF EXISTS "ai_interactions_sessionId_timestamp_idx";
-- DROP INDEX IF EXISTS "ai_interactions_eventType_idx";
-- DROP INDEX IF EXISTS "ai_interactions_timestamp_idx";

