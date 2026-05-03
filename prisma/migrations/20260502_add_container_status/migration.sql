-- Add container_status column to sessions table
-- Tracks the pre-provisioning lifecycle: pending → provisioning → ready | failed
-- This ensures candidates see a spinner until the container is confirmed running
-- and the /start route never silently falls back to on-demand provisioning.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS container_status TEXT DEFAULT 'pending';

-- Backfill existing sessions that already have a containerUrl → mark them as ready
UPDATE sessions SET container_status = 'ready' WHERE container_url IS NOT NULL;
