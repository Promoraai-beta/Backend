/**
 * Supabase Storage Helper
 * Provides secure URL generation for private buckets using signed URLs
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const BUCKET_NAME = process.env.SUPABASE_STORAGE_BUCKET || 'video';
const SIGNED_URL_EXPIRY = 31536000; // 1 year in seconds

/**
 * Get a signed URL for a file in Supabase Storage
 * This allows secure access to files in a private bucket without making it public
 * 
 * @param filePath - Path to the file in the bucket
 * @param expiresIn - Expiration time in seconds (default: 1 year)
 * @returns Signed URL or null if error
 */
export async function getSignedUrl(filePath: string, expiresIn: number = SIGNED_URL_EXPIRY): Promise<string | null> {
  if (!supabase) {
    console.error('Supabase client not initialized');
    return null;
  }

  try {
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(filePath, expiresIn);

    if (error) {
      console.error('Error creating signed URL:', error);
      return null;
    }

    return data.signedUrl;
  } catch (error) {
    console.error('Exception creating signed URL:', error);
    return null;
  }
}

/**
 * Get public URL for a file (fallback if bucket is public)
 * 
 * @param filePath - Path to the file in the bucket
 * @returns Public URL
 */
export function getPublicUrl(filePath: string): string | null {
  if (!supabase) {
    console.error('Supabase client not initialized');
    return null;
  }

  try {
    const { data } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    return data.publicUrl;
  } catch (error) {
    console.error('Error getting public URL:', error);
    return null;
  }
}

/**
 * Extract file path from Supabase URL
 * Handles both full URLs and file paths
 * 
 * @param urlOrPath - Full Supabase URL or file path
 * @returns File path within the bucket
 */
function extractFilePath(urlOrPath: string): string {
  // If it's already a path (doesn't start with http), return as-is
  if (!urlOrPath.startsWith('http')) {
    return urlOrPath;
  }

  // Extract path from Supabase URL
  // Format: https://[project].supabase.co/storage/v1/object/public/[bucket]/[path]
  // or: https://[project].supabase.co/storage/v1/object/sign/[bucket]/[path]?token=...
  try {
    const url = new URL(urlOrPath);
    const pathParts = url.pathname.split('/');
    
    // Find the bucket name index and get everything after it
    const bucketIndex = pathParts.findIndex(part => part === BUCKET_NAME);
    if (bucketIndex !== -1 && bucketIndex < pathParts.length - 1) {
      return pathParts.slice(bucketIndex + 1).join('/');
    }
    
    // Fallback: try to extract from pathname directly
    const match = url.pathname.match(new RegExp(`/${BUCKET_NAME}/(.+)$`));
    if (match && match[1]) {
      return match[1];
    }
  } catch (e) {
    // If URL parsing fails, assume it's already a path
    console.warn('Failed to parse URL, using as path:', urlOrPath);
  }
  
  return urlOrPath;
}

/**
 * Refresh signed URL for a profile image
 * Useful when URLs are about to expire
 * 
 * @param urlOrPath - Full Supabase URL or file path
 * @returns New signed URL or existing public URL as fallback
 */
export async function refreshImageUrl(urlOrPath: string | null | undefined): Promise<string | null> {
  if (!urlOrPath) {
    return null;
  }

  // Extract file path from URL if needed
  const filePath = extractFilePath(urlOrPath);
  
  // Try signed URL first (more secure)
  const signedUrl = await getSignedUrl(filePath);
  if (signedUrl) {
    return signedUrl;
  }

  // Fallback to public URL if signed URL fails
  return getPublicUrl(filePath);
}

