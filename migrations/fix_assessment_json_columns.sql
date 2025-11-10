-- Migration: Convert columns to JSONB for better performance and data handling
-- This fixes the "array dimensions exceeds maximum" error

-- Handle tech_stack: Convert text[] to jsonb
-- Check if it's text[] and convert to jsonb array
DO $$
BEGIN
    -- Check if tech_stack column exists and is text[]
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public'
        AND table_name = 'assessments' 
        AND column_name = 'tech_stack'
        AND data_type = 'ARRAY'
    ) THEN
        -- Convert text[] to jsonb array
        ALTER TABLE assessments 
        ALTER COLUMN tech_stack TYPE jsonb 
        USING to_jsonb(tech_stack)::jsonb;
    -- If it's json, convert to jsonb
    ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public'
        AND table_name = 'assessments' 
        AND column_name = 'tech_stack'
        AND data_type = 'json'
    ) THEN
        ALTER TABLE assessments 
        ALTER COLUMN tech_stack TYPE jsonb 
        USING tech_stack::jsonb;
    -- If it's already jsonb, do nothing
    END IF;
END $$;

-- Convert template column from JSON to JSONB (if it exists and is json type)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'assessments' 
        AND column_name = 'template' 
        AND udt_name = 'json'
    ) THEN
        ALTER TABLE assessments
        ALTER COLUMN template TYPE jsonb 
        USING template::jsonb;
    END IF;
END $$;

-- Add indexes for better query performance on JSONB columns
CREATE INDEX IF NOT EXISTS assessments_tech_stack_gin_idx ON assessments USING gin (tech_stack) WHERE tech_stack IS NOT NULL;
CREATE INDEX IF NOT EXISTS assessments_template_gin_idx ON assessments USING gin (template) WHERE template IS NOT NULL;

