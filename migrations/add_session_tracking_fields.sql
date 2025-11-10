-- Add fields for session security tracking
-- lastActivityAt: Track last activity timestamp for inactivity detection
-- tabSwitchCount: Track number of tab switches
-- lastTabSwitchAt: Track last tab switch timestamp

ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS tab_switch_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_tab_switch_at TIMESTAMP;

-- Create index on last_activity_at for efficient inactivity queries
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity_at ON sessions(last_activity_at) WHERE status = 'active';

-- Create index on status for efficient active session queries
CREATE INDEX IF NOT EXISTS idx_sessions_status_active ON sessions(status) WHERE status = 'active';

