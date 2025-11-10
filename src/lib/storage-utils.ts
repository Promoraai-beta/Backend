/**
 * Storage utility functions for building S3/Supabase storage paths
 * Following the folder structure:
 * 
 * companies/
 *   {companyName}/
 *     jobs/
 *       {jobName}/
 *         {candidateName}/
 *           webcam/
 *           screenshare/
 *     images/
 *       company_logo.jpg
 * 
 * photos/
 *   recruiters/
 *     {recruiterName}/
 *       profile_image.jpg
 *   candidates/
 *     {candidateName}/
 *       profile_image.jpg
 */

/**
 * Sanitize a string for use as a folder/file name
 * Removes special characters, spaces, and ensures it's safe for storage
 */
export function sanitizeName(name: string): string {
  if (!name) return 'unknown';
  
  // Remove special characters, keep only alphanumeric, hyphens, and underscores
  // Replace spaces with underscores
  // Convert to lowercase for consistency
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '_')  // Replace special chars with underscore
    .replace(/_+/g, '_')            // Replace multiple underscores with single
    .replace(/^_+|_+$/g, '')        // Remove leading/trailing underscores
    .substring(0, 100)              // Limit length to 100 chars
    || 'unknown';
}

/**
 * Build video chunk path for company job candidate videos
 * Format: companies/{companyName}/jobs/{jobName}/{candidateName}/{streamType}/chunk_{index}_{timestamp}.webm
 */
export function buildVideoChunkPath(
  companyName: string,
  jobName: string,
  candidateName: string,
  streamType: 'webcam' | 'screenshare' | 'combined',
  chunkIndex: number,
  timestamp: number
): string {
  const sanitizedCompany = sanitizeName(companyName);
  const sanitizedJob = sanitizeName(jobName);
  const sanitizedCandidate = sanitizeName(candidateName);
  const sanitizedStreamType = streamType === 'combined' ? 'screenshare' : streamType; // Use screenshare as default if combined
  
  const filename = `chunk_${chunkIndex}_${timestamp}.webm`;
  
  return `companies/${sanitizedCompany}/jobs/${sanitizedJob}/${sanitizedCandidate}/${sanitizedStreamType}/${filename}`;
}

/**
 * Build company logo path
 * Format: companies/{companyName}/images/company_logo_{timestamp}.{ext}
 */
export function buildCompanyLogoPath(
  companyName: string,
  timestamp: number,
  extension: string = 'jpg'
): string {
  const sanitizedCompany = sanitizeName(companyName);
  
  return `companies/${sanitizedCompany}/images/company_logo_${timestamp}.${extension}`;
}

/**
 * Build recruiter profile image path
 * Format: photos/recruiters/{recruiterName}/profile_image_{timestamp}.{ext}
 */
export function buildRecruiterImagePath(
  recruiterName: string,
  timestamp: number,
  extension: string = 'jpg'
): string {
  const sanitizedRecruiter = sanitizeName(recruiterName);
  
  return `photos/recruiters/${sanitizedRecruiter}/profile_image_${timestamp}.${extension}`;
}

/**
 * Build candidate profile image path
 * Format: photos/candidates/{candidateName}/profile_image_{timestamp}.{ext}
 */
export function buildCandidateImagePath(
  candidateName: string,
  timestamp: number,
  extension: string = 'jpg'
): string {
  const sanitizedCandidate = sanitizeName(candidateName);
  
  return `photos/candidates/${sanitizedCandidate}/profile_image_${timestamp}.${extension}`;
}

/**
 * Extract file extension from filename or MIME type
 */
export function getFileExtension(filename: string, mimeType?: string): string {
  // Try to get extension from filename
  const filenameParts = filename.split('.');
  if (filenameParts.length > 1) {
    const ext = filenameParts.pop()?.toLowerCase();
    if (ext && ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      return ext;
    }
  }
  
  // Fallback to MIME type
  if (mimeType) {
    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
    };
    return mimeMap[mimeType] || 'jpg';
  }
  
  return 'jpg'; // Default
}

