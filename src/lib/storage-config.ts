/**
 * Unified Storage Configuration
 * Supports both Supabase Storage (via JS client) and S3-compatible API
 * 
 * Configuration Priority:
 * 1. If S3_ENDPOINT is set, use S3-compatible storage
 * 2. Otherwise, use Supabase JS client (existing implementation)
 */

export interface StorageConfig {
  type: 's3' | 'supabase';
  endpoint?: string;
  region?: string;
  bucket: string;
  configured: boolean;
}

/**
 * Get storage configuration from environment variables
 */
export function getStorageConfig(): StorageConfig {
  const s3Endpoint = process.env.S3_ENDPOINT || process.env.SUPABASE_S3_ENDPOINT;
  const supabaseUrl = process.env.SUPABASE_URL;
  const bucket = process.env.S3_BUCKET || 
                 process.env.SUPABASE_STORAGE_BUCKET || 
                 'video';
  
  // Check if S3 is configured
  // For Supabase, service role key can be used as both access key and secret
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID || 
                      process.env.SUPABASE_ACCESS_KEY || 
                      process.env.SUPABASE_SERVICE_KEY;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY || 
                      process.env.SUPABASE_SECRET_KEY || 
                      process.env.SUPABASE_SERVICE_KEY;
  
  if (s3Endpoint && s3AccessKey && s3SecretKey) {
    return {
      type: 's3',
      endpoint: s3Endpoint,
      region: process.env.S3_REGION || process.env.SUPABASE_S3_REGION || 'us-east-1',
      bucket,
      configured: true,
    };
  }
  
  // Fallback to Supabase JS client
  if (supabaseUrl && process.env.SUPABASE_SERVICE_KEY) {
    return {
      type: 'supabase',
      bucket,
      configured: true,
    };
  }
  
  return {
    type: 'supabase',
    bucket,
    configured: false,
  };
}

/**
 * Get the storage type being used
 */
export function getStorageType(): 's3' | 'supabase' {
  return getStorageConfig().type;
}

/**
 * Check if storage is configured
 */
export function isStorageConfigured(): boolean {
  return getStorageConfig().configured;
}

