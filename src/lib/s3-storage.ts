/**
 * S3-Compatible Storage Helper for Supabase
 * Provides direct S3 API access for Supabase Storage
 * 
 * Supabase Storage is S3-compatible and can be accessed using the AWS S3 SDK
 * 
 * Configuration:
 * - S3_ENDPOINT: https://[project-id].storage.supabase.co/storage/v1/s3
 * - S3_REGION: us-east-1 (or your region)
 * - S3_ACCESS_KEY_ID: Your Supabase service role key
 * - S3_SECRET_ACCESS_KEY: Your Supabase service role secret
 * - S3_BUCKET: Your bucket name (default: 'video')
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './logger';

// S3 Configuration from environment variables
const S3_ENDPOINT = process.env.S3_ENDPOINT || process.env.SUPABASE_S3_ENDPOINT || '';
const S3_REGION = process.env.S3_REGION || process.env.SUPABASE_S3_REGION || 'us-east-1';
// For Supabase, the service role key is used as both access key and secret
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || 
                         process.env.SUPABASE_ACCESS_KEY || 
                         process.env.SUPABASE_SERVICE_KEY || 
                         '';
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || 
                             process.env.SUPABASE_SECRET_KEY || 
                             process.env.SUPABASE_SERVICE_KEY || 
                             '';
const S3_BUCKET = process.env.S3_BUCKET || process.env.SUPABASE_STORAGE_BUCKET || 'video';

// Check if S3 configuration is available
const isS3Configured = !!(S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);

// Initialize S3 client if configured
let s3Client: S3Client | null = null;

if (isS3Configured) {
  s3Client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true, // Required for Supabase S3-compatible storage
  });
}

/**
 * Upload a file to S3-compatible storage
 * 
 * @param filePath - Path to store the file in the bucket
 * @param fileBuffer - File buffer to upload
 * @param contentType - MIME type of the file
 * @returns URL of the uploaded file or null if error
 */
export async function uploadToS3(
  filePath: string,
  fileBuffer: Buffer,
  contentType: string = 'application/octet-stream'
): Promise<string | null> {
  if (!s3Client) {
    logger.error('S3 client not configured. Please set S3_ENDPOINT, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.');
    return null;
  }

  try {
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: filePath,
      Body: fileBuffer,
      ContentType: contentType,
    });

    await s3Client.send(command);

    // Return the public URL
    // For Supabase, construct the URL like:
    // https://[project-id].supabase.co/storage/v1/object/public/[bucket]/[path]
    const baseUrl = S3_ENDPOINT.replace('/storage/v1/s3', '');
    const publicUrl = `${baseUrl}/storage/v1/object/public/${S3_BUCKET}/${filePath}`;
    
    logger.log(`File uploaded to S3: ${filePath}`);
    return publicUrl;
  } catch (error) {
    logger.error('Error uploading to S3:', error);
    return null;
  }
}

/**
 * Get a signed URL for a file in S3-compatible storage
 * 
 * @param filePath - Path to the file in the bucket
 * @param expiresIn - Expiration time in seconds (default: 3600 = 1 hour)
 * @returns Signed URL or null if error
 */
export async function getS3SignedUrl(
  filePath: string,
  expiresIn: number = 3600
): Promise<string | null> {
  if (!s3Client) {
    logger.error('S3 client not configured');
    return null;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: filePath,
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    return signedUrl;
  } catch (error) {
    logger.error('Error generating signed URL:', error);
    return null;
  }
}

/**
 * Get public URL for a file (if bucket is public)
 * 
 * @param filePath - Path to the file in the bucket
 * @returns Public URL
 */
export function getS3PublicUrl(filePath: string): string | null {
  if (!S3_ENDPOINT) {
    logger.error('S3 endpoint not configured');
    return null;
  }

  try {
    // Construct public URL for Supabase Storage
    const baseUrl = S3_ENDPOINT.replace('/storage/v1/s3', '');
    return `${baseUrl}/storage/v1/object/public/${S3_BUCKET}/${filePath}`;
  } catch (error) {
    logger.error('Error constructing public URL:', error);
    return null;
  }
}

/**
 * Delete a file from S3-compatible storage
 * 
 * @param filePath - Path to the file in the bucket
 * @returns true if successful, false otherwise
 */
export async function deleteFromS3(filePath: string): Promise<boolean> {
  if (!s3Client) {
    logger.error('S3 client not configured');
    return false;
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: filePath,
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    logger.error('Error deleting from S3:', error);
    return false;
  }
}

/**
 * Check if a file exists in S3-compatible storage
 * 
 * @param filePath - Path to the file in the bucket
 * @returns true if file exists, false otherwise
 */
export async function fileExistsInS3(filePath: string): Promise<boolean> {
  if (!s3Client) {
    logger.error('S3 client not configured');
    return false;
  }

  try {
    const command = new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: filePath,
    });

    await s3Client.send(command);
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    logger.error('Error checking file existence:', error);
    return false;
  }
}

/**
 * Check if S3 storage is configured and available
 * 
 * @returns true if S3 is configured, false otherwise
 */
export function isS3StorageAvailable(): boolean {
  return isS3Configured && s3Client !== null;
}

/**
 * Get S3 configuration info (for debugging, without sensitive data)
 * 
 * @returns Configuration object
 */
export function getS3Config() {
  return {
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    bucket: S3_BUCKET,
    configured: isS3Configured,
  };
}

