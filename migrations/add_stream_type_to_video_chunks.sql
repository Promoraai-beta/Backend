-- Add stream_type column to video_chunks table
-- This migration adds the streamType field to distinguish between webcam, screenshare, and combined streams

-- Add stream_type column with default value 'screenshare'
ALTER TABLE video_chunks 
ADD COLUMN IF NOT EXISTS stream_type VARCHAR(20) DEFAULT 'screenshare' NOT NULL;

-- Update existing records to have stream_type = 'screenshare' (backward compatibility)
UPDATE video_chunks 
SET stream_type = 'screenshare' 
WHERE stream_type IS NULL;

-- Add index for efficient querying by sessionId, streamType, and chunkIndex
CREATE INDEX IF NOT EXISTS video_chunks_session_id_stream_type_chunk_index_idx 
ON video_chunks(session_id, stream_type, chunk_index);

-- Add comment to explain the column
COMMENT ON COLUMN video_chunks.stream_type IS 'Type of video stream: webcam, screenshare, or combined';

