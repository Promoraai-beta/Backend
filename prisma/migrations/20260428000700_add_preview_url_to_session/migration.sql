-- Add preview URL fields to sessions table
-- preview_url: the direct Vite :5173 URL (null for old containers)
-- supports_direct_preview: flag to hide the Preview tab on old sessions gracefully

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "preview_url" TEXT,
  ADD COLUMN IF NOT EXISTS "supports_direct_preview" BOOLEAN NOT NULL DEFAULT FALSE;
