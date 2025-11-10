import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { updateHLSPlaylist, getHLSPlaylistUrl } from '../lib/hls';
import { buildVideoChunkPath, sanitizeName } from '../lib/storage-utils';

const router = Router();

// Supabase storage client
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Local storage directory
const LOCAL_STORAGE_DIR = path.join(process.cwd(), 'uploads', 'videos');

// Ensure directory exists
if (!fs.existsSync(LOCAL_STORAGE_DIR)) {
  fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
}

// Configure multer for in-memory storage (for Supabase upload)
const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

/**
 * POST /api/video/upload
 * Upload video chunk to storage (Supabase or local)
 */
import { videoUploadLimiter } from '../middleware/rate-limiter';

// Custom validation middleware that runs AFTER multer processes FormData
const validateVideoUploadAfterMulter = (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.body.sessionId;
  const chunkIndex = req.body.chunkIndex;
  const streamType = req.body.streamType;
  const file = req.file;

  // Validate sessionId
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: [{
        type: 'field',
        msg: 'Session ID is required',
        path: 'sessionId',
        location: 'body'
      }]
    });
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sessionId)) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: [{
        type: 'field',
        msg: 'Invalid session ID format',
        path: 'sessionId',
        location: 'body'
      }]
    });
  }

  // Validate chunkIndex
  if (!chunkIndex) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: [{
        type: 'field',
        msg: 'Chunk index is required',
        path: 'chunkIndex',
        location: 'body'
      }]
    });
  }

  const index = parseInt(chunkIndex, 10);
  if (isNaN(index) || index < 0) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: [{
        type: 'field',
        msg: 'Invalid chunk index',
        path: 'chunkIndex',
        location: 'body'
      }]
    });
  }

  // ✅ CRITICAL: streamType is REQUIRED - validate it
  if (!streamType || typeof streamType !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: [{
        type: 'field',
        msg: 'streamType is required and must be "webcam" or "screenshare"',
        path: 'streamType',
        location: 'body'
      }]
    });
  }

  // Only allow 'webcam' or 'screenshare' - no 'combined' or other values
  if (!['webcam', 'screenshare'].includes(streamType)) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: [{
        type: 'field',
        msg: `Invalid streamType: "${streamType}". Must be "webcam" or "screenshare"`,
        path: 'streamType',
        location: 'body'
      }]
    });
  }

  // Validate file
  if (!file) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: [{
        type: 'field',
        msg: 'Video file is required',
        path: 'video',
        location: 'body'
      }]
    });
  }

  // Validate file size
  // Chunk 0 contains WebM header/initialization (should be larger, e.g., > 1KB)
  // Subsequent chunks are fragments (can be any size > 0, even very small if video is static)
  if (file.size === 0) {
    console.error(`Chunk ${chunkIndex} (${streamType}): Empty file (0 bytes)`);
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: [{
        type: 'field',
        msg: 'Video chunk is empty (0 bytes)',
        path: 'video',
        location: 'body'
      }]
    });
  }

  // Chunk 0 should be larger (contains WebM header), but don't reject if smaller
  // Some MediaRecorder implementations might create smaller headers
  const MIN_CHUNK_0_SIZE = 100; // Very permissive - just ensure it's not empty
  if (chunkIndex === 0 && file.size < MIN_CHUNK_0_SIZE) {
    console.warn(`Chunk 0 (${streamType}): Very small (${file.size} bytes), expected larger for WebM header`);
    // Don't reject - still allow upload
  }

  // Validate WebM file format ONLY for chunk 0 (which should have the header)
  // Fragments (chunkIndex > 0) don't have headers - they're just data fragments
  if (chunkIndex === 0 && file.buffer && file.buffer.length >= 4) {
    const magicBytes = file.buffer.slice(0, 4);
    const webmMagic = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);
    
    if (magicBytes.equals(webmMagic)) {
      console.log(`✅ Chunk 0 (${streamType}): Valid WebM header detected (${file.size} bytes)`);
    } else {
      console.warn(`Chunk 0 (${streamType}): Missing WebM magic bytes (1A 45 DF A3), got: ${magicBytes.toString('hex')}`);
      console.warn(`File size: ${file.size} bytes, First 32 bytes: ${file.buffer.slice(0, Math.min(32, file.buffer.length)).toString('hex')}`);
      
      // Check if it's just empty or corrupted data (all zeros)
      const hasNonZeroData = file.buffer.some((byte: number) => byte !== 0);
      if (!hasNonZeroData) {
        console.error(`Chunk 0 (${streamType}): File contains only zeros - corrupted or empty`);
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: [{
            type: 'field',
            msg: 'Video chunk 0 appears to be corrupted or empty (contains only zeros)',
            path: 'video',
            location: 'body'
          }]
        });
      }
      
      // Chunk 0 without magic bytes is unusual but might still work
      // Don't reject - allow upload and let playback handle it
      console.warn(`Chunk 0 (${streamType}): Missing WebM header, but contains data. Proceeding with upload.`);
    }
  } else if (chunkIndex > 0) {
    // Fragments (chunkIndex > 0) are just data - no header validation needed
    // They can be any size > 0
    console.log(`✅ Fragment ${chunkIndex} (${streamType}): ${file.size} bytes`);
  }

  next();
};

router.post('/upload', videoUploadLimiter, upload.single('video'), validateVideoUploadAfterMulter, async (req: Request, res: Response) => {
  try {
    // FormData sends values as strings, so parse them
    const sessionId = req.body.sessionId;
    const chunkIndex = parseInt(req.body.chunkIndex, 10);
    
    // ✅ CRITICAL: streamType is REQUIRED - do not default
    // If validation middleware didn't catch it, this is a critical error
    const streamType = req.body.streamType;
    if (!streamType || !['webcam', 'screenshare'].includes(streamType)) {
      console.error(`❌ CRITICAL: Invalid or missing streamType: ${streamType}`);
      return res.status(400).json({
        success: false,
        error: `Invalid or missing streamType. Received: "${streamType}". Must be "webcam" or "screenshare"`
      });
    }
    
    const file = req.file;
    
    // ✅ Log streamType for debugging
    console.log(`\n📤 Upload request: { sessionId: '${sessionId}', streamType: '${streamType}', chunkIndex: ${chunkIndex} }`);

    // Validation is now handled by middleware, but keep this as a safety check
    if (!sessionId || chunkIndex === undefined || !file) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: sessionId, chunkIndex, or video file'
      });
    }

    // Additional validation: Only reject truly empty files
    // Note: Middleware already validates, but this is a safety check
    // IMPORTANT: Fragments (chunkIndex > 0) can be very small - don't reject them!
    // Only chunk 0 needs to be larger (contains WebM header), fragments are just data
    if (file.size === 0) {
      console.error(`Rejecting chunk ${chunkIndex} (${streamType}): Empty file (0 bytes)`);
      return res.status(400).json({
        success: false,
        error: `Video chunk is empty (0 bytes)`
      });
    }
    
    // Chunk 0 should be larger, but don't reject if smaller (some MediaRecorder implementations vary)
    if (chunkIndex === 0 && file.size < 100) {
      console.warn(`Chunk 0 (${streamType}): Very small (${file.size} bytes), but allowing upload`);
      // Don't reject - allow upload
    }
    
    // Fragments (chunkIndex > 0) can be any size > 0 - they're just data fragments
    // Don't reject small fragments - they're valid!

    // Log chunk info for debugging
    console.log(`📦 Uploading chunk ${chunkIndex} (${streamType}): ${file.size} bytes, MIME: ${file.mimetype || 'video/webm'}`);

    // Fetch session details to get candidate name, assessment, and company info
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        assessment: {
          include: {
            company: true
          }
        }
      }
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // SECURITY: Only allow video uploads for recruiter assessments
    // Candidate assessments should not record video
    if (session.assessment?.assessmentType === 'candidate') {
      return res.status(403).json({
        success: false,
        error: 'Video recording is not allowed for candidate-created assessments. Only recruiter assessments can record video.'
      });
    }

    // Get company name, job name, and candidate name for folder structure
    // Format: companies/{companyName}/jobs/{jobName}/{candidateName}/{webcam|screenshare}/chunk_*.webm
    const companyName = session.assessment?.company?.name || 'UnknownCompany';
    const jobName = session.assessment?.jobTitle || session.assessment?.role || 'UnknownJob';
    const candidateName = session.candidateName || session.sessionCode || 'UnknownCandidate';
    
    // ✅ CRITICAL: Use the validated streamType (no fallback)
    const streamTypeForPath = streamType as 'webcam' | 'screenshare';
    
    // ✅ Verify streamType matches what we're using for path
    if (streamTypeForPath !== streamType) {
      console.error(`❌ CRITICAL: streamType mismatch! Path uses "${streamTypeForPath}" but validated streamType is "${streamType}"`);
      return res.status(500).json({
        success: false,
        error: 'Internal error: streamType mismatch'
      });
    }
    
    console.log(`📁 Building path for ${streamType} chunk ${chunkIndex}:`);
    console.log(`   companies/${companyName}/jobs/${jobName}/${candidateName}/${streamTypeForPath}/`);

    // ✅ CRITICAL: Check if a chunk with the same chunkIndex and streamType already exists
    // If it does, we need to delete the old file to avoid duplicates
    const existingChunk = await prisma.videoChunk.findFirst({
      where: {
        sessionId,
        chunkIndex,
        streamType: streamTypeForPath
      }
    });

    let oldFilePath: string | null = null;
    if (existingChunk) {
      console.log(`⚠️ Found existing chunk ${chunkIndex} (${streamTypeForPath}) for session ${sessionId}`);
      console.log(`   Old URL: ${existingChunk.url}`);
      
      // Extract the file path from the URL
      // URL format: https://{supabase-url}/storage/v1/object/public/{bucket}/{path}
      const urlParts = existingChunk.url.split('/storage/v1/object/public/');
      if (urlParts.length > 1) {
        const pathWithBucket = urlParts[1]; // e.g., "video/companies/..."
        const pathParts = pathWithBucket.split('/');
        if (pathParts.length > 1) {
          // Remove the bucket name (first part) and join the rest
          oldFilePath = pathParts.slice(1).join('/');
          console.log(`   Old file path: ${oldFilePath}`);
        }
      }
    }

    // Build file path using new folder structure
    const timestamp = Date.now();
    const filePath = buildVideoChunkPath(
      companyName,
      jobName,
      candidateName,
      streamTypeForPath,
      chunkIndex,
      timestamp
    );
    
    let url: string = '';
    let sizeBytes: bigint = BigInt(0);

    // Use ONLY Supabase - no local storage fallback
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Supabase storage not configured'
      });
    }

    try {
      // Use "video" as the default bucket name
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';

      // ✅ Delete old file if it exists (to prevent duplicates)
      // Note: We'll delete the database record after successful upload
      if (oldFilePath && existingChunk) {
        try {
          console.log(`🗑️ Deleting old chunk file: ${oldFilePath}`);
          const { error: deleteError } = await supabase.storage
            .from(bucket)
            .remove([oldFilePath]);
          
          if (deleteError) {
            console.warn(`⚠️ Failed to delete old file ${oldFilePath}:`, deleteError);
            // Continue with upload even if delete fails - we'll handle cleanup later
          } else {
            console.log(`✅ Deleted old chunk file: ${oldFilePath}`);
          }
        } catch (deleteError) {
          console.warn(`⚠️ Error deleting old file:`, deleteError);
          // Continue with upload
        }
      }

      console.log(`Uploading to Supabase: ${filePath} (${file.size} bytes)`);
      console.log(`📁 New folder structure: companies/{company}/jobs/{job}/{candidate}/{streamType}/`);
      
      // Retry logic for Supabase upload
      let uploadSuccess = false;
      let lastError: any = null;
      const maxRetries = 3;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`Retry attempt ${attempt}/${maxRetries} for ${filePath}`);
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
          
          // Upload to Supabase Storage with new folder structure
          const { data, error } = await supabase.storage
            .from(bucket)
            .upload(filePath, file.buffer, {
              contentType: 'video/webm',
              upsert: false
            });

          if (error) {
            console.error(`Upload attempt ${attempt} error:`, error);
            throw error;
          }

          // Get public URL
          const { data: urlData } = supabase.storage
            .from(bucket)
            .getPublicUrl(filePath);

          url = urlData.publicUrl;
          sizeBytes = BigInt(file.size);
          uploadSuccess = true;
          console.log(`✅ Supabase upload successful: ${filePath}`);
          break;
        } catch (retryError: any) {
          lastError = retryError;
        }
      }

      if (!uploadSuccess) {
        console.error('All retry attempts failed for:', filePath);
        console.error('Last error:', lastError);
        throw lastError || new Error('Upload failed after retries');
      }

    } catch (supabaseError) {
      console.error('Supabase upload failed:', supabaseError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload video to storage'
      });
    }

    // Save metadata to database (required for HLS playlist generation)
    // The actual video file is stored in Supabase bucket
    // Database table is essential for:
    // - HLS playlist generation (needs ordered chunks by chunkIndex)
    // - Fast queries (avoid listing Supabase files on every playlist update)
    // - Tracking which chunks belong to which session
    // - Calculating storage usage and analytics
    // - Debugging missing chunks
    // 
    // IMPORTANT: If DB write fails, we still return success since file is in Supabase
    // The chunk will be missing from playlists until manually synced, but file is safe
    let videoChunk = null;
    try {
      // ✅ CRITICAL: Verify streamType matches URL path before saving
      const urlContainsStreamType = url.includes(`/${streamType}/`);
      if (!urlContainsStreamType) {
        console.error(`❌ CRITICAL: URL path mismatch! streamType="${streamType}" but URL="${url.substring(0, 100)}..."`);
        console.error(`Expected URL to contain "/${streamType}/" but it doesn't!`);
        console.error(`This is a critical error - the chunk will be saved with incorrect streamType!`);
        // Don't fail upload, but log the error - this should never happen if code is correct
      } else {
        console.log(`✅ URL path verification passed: URL contains "/${streamType}/"`);
      }
      
      console.log(`📤 Uploading to: ${url.substring(Math.max(0, url.length - 80))}`);
      
      videoChunk = await prisma.videoChunk.create({
        data: {
          sessionId,
          chunkIndex: chunkIndex, // Already an integer from parsing above
          streamType: streamType, // ✅ Save validated streamType ('webcam' | 'screenshare')
          url,
          sizeBytes
        }
      });
      
      // ✅ Delete old database record if it existed (now that new one is saved)
      if (existingChunk && existingChunk.id !== videoChunk.id) {
        try {
          await prisma.videoChunk.delete({
            where: { id: existingChunk.id }
          });
          console.log(`✅ Deleted old chunk record from database (id: ${existingChunk.id})`);
        } catch (dbDeleteError) {
          console.warn(`⚠️ Failed to delete old chunk from database:`, dbDeleteError);
          // Not critical - old record will just be orphaned
        }
      }
      
      // ✅ Verify what was saved
      console.log(`✅ Saved ${streamType} chunk ${chunkIndex} to database`);
      console.log(`   URL: ${url.substring(Math.max(0, url.length - 80))}`);
      console.log(`   Size: ${file.size} bytes`);
    } catch (dbError: any) {
      // Log error but don't fail the upload - file is already in Supabase
      // This ensures we don't lose video data even if DB write fails
      console.error(`Failed to save chunk metadata to database (chunk ${chunkIndex}):`, dbError);
      // Continue - file is in Supabase, DB metadata can be synced later if needed
    }

    // Update HLS playlist in background (don't wait for it)
    // Only updates if DB write succeeded (chunk exists in DB)
    if (videoChunk) {
      updateHLSPlaylist(sessionId).catch(err => {
        console.error('Failed to update HLS playlist:', err);
      });
    }

    // Return response with chunk data (or basic info if DB write failed)
    res.json({
      success: true,
      data: videoChunk ? {
        ...videoChunk,
        sizeBytes: Number(videoChunk.sizeBytes) // Convert BigInt to Number for JSON
      } : {
        sessionId,
        chunkIndex,
        url,
        sizeBytes: Number(sizeBytes),
        // Note: Not in database, but file is in Supabase
        metadataSaved: false
      },
      message: 'Video chunk uploaded successfully'
    });

  } catch (error: any) {
    console.error('Video upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload video chunk'
    });
  }
});

/**
 * GET /api/video/:sessionId
 * Get all video chunks for a session
 * Returns grouped data: { webcam: [...], screenshare: [...] }
 * Optional query parameter: streamType (filter by 'webcam' or 'screenshare')
 */
router.get('/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { streamType } = req.query; // Optional filter by stream type

    console.log(`\n📥 GET /api/video/${sessionId}${streamType ? `?streamType=${streamType}` : ''}`);

    // ✅ CRITICAL: Fetch webcam and screenshare separately for better validation
    const [webcamChunks, screenshareChunks] = await Promise.all([
      prisma.videoChunk.findMany({
        where: {
          sessionId,
          streamType: 'webcam'
        },
        orderBy: { chunkIndex: 'asc' }
      }),
      prisma.videoChunk.findMany({
        where: {
          sessionId,
          streamType: 'screenshare'
        },
        orderBy: { chunkIndex: 'asc' }
      })
    ]);

    console.log(`📊 Found ${webcamChunks.length} webcam chunks, ${screenshareChunks.length} screenshare chunks`);

    // ✅ CRITICAL: Verify and fix URLs to match streamType
    const webcamMismatches: any[] = [];
    const correctedWebcamChunks = webcamChunks.map(chunk => {
      if (!chunk.url.includes('/webcam/')) {
        webcamMismatches.push({
          chunkId: chunk.id,
          chunkIndex: chunk.chunkIndex,
          streamType: chunk.streamType,
          url: chunk.url
        });
        // Fix URL by replacing wrong path segment
        // NOTE: This is a best-effort correction. The corrected URL may not exist.
        // The frontend will handle 404 errors gracefully by skipping missing files
        let correctedUrl = chunk.url;
        if (chunk.url.includes('/screenshare/')) {
          correctedUrl = chunk.url.replace('/screenshare/', '/webcam/');
          console.warn(`⚠️ Fixing webcam chunk ${chunk.chunkIndex} URL: replacing /screenshare/ with /webcam/`);
          console.warn(`   ⚠️ WARNING: Corrected URL may not exist if file has different timestamp or location`);
        }
        return { ...chunk, url: correctedUrl };
      }
      return chunk;
    });

    // ✅ CRITICAL: Verify and fix URLs to match streamType for screenshare chunks
    const screenshareMismatches: any[] = [];
    const correctedScreenshareChunks = screenshareChunks.map(chunk => {
      if (!chunk.url.includes('/screenshare/')) {
        screenshareMismatches.push({
          chunkId: chunk.id,
          chunkIndex: chunk.chunkIndex,
          streamType: chunk.streamType,
          url: chunk.url
        });
        // Fix URL by replacing wrong path segment
        // NOTE: This is a best-effort correction. The corrected URL may not exist if:
        // - The file was uploaded with a different timestamp
        // - The file is stored in a different location
        // - The database has stale/inconsistent data
        // The frontend will handle 404 errors gracefully by skipping missing files
        let correctedUrl = chunk.url;
        if (chunk.url.includes('/webcam/')) {
          correctedUrl = chunk.url.replace('/webcam/', '/screenshare/');
          console.warn(`⚠️ Fixing screenshare chunk ${chunk.chunkIndex} URL: replacing /webcam/ with /screenshare/`);
          console.warn(`   Original: ${chunk.url.substring(Math.max(0, chunk.url.length - 80))}`);
          console.warn(`   Corrected: ${correctedUrl.substring(Math.max(0, correctedUrl.length - 80))}`);
          console.warn(`   ⚠️ WARNING: Corrected URL may not exist if file has different timestamp or location`);
          console.warn(`   ⚠️ Frontend will skip missing files and continue with available chunks`);
        }
        return { ...chunk, url: correctedUrl };
      }
      return chunk;
    });

    // Log mismatches
    if (webcamMismatches.length > 0) {
      console.error(`❌ Found ${webcamMismatches.length} webcam chunks with WRONG URL paths:`);
      webcamMismatches.forEach(m => {
        console.error(`  Chunk ${m.chunkIndex}: DB streamType="${m.streamType}" but URL="${m.url.substring(0, 100)}..."`);
      });
    }

    if (screenshareMismatches.length > 0) {
      console.error(`❌ Found ${screenshareMismatches.length} screenshare chunks with WRONG URL paths:`);
      screenshareMismatches.forEach(m => {
        console.error(`  Chunk ${m.chunkIndex}: DB streamType="${m.streamType}" but URL="${m.url.substring(0, 100)}..."`);
      });
    }

    // Log first few chunks of each type for debugging
    if (correctedWebcamChunks.length > 0) {
      console.log(`\n✅ WEBCAM CHUNKS (first 3):`);
      correctedWebcamChunks.slice(0, 3).forEach(chunk => {
        const urlSnippet = chunk.url.substring(Math.max(0, chunk.url.length - 60));
        const urlMatch = chunk.url.includes('/webcam/') ? '✓' : '❌';
        console.log(`  Chunk ${chunk.chunkIndex}: ${urlMatch} ${urlSnippet}`);
      });
    }

    if (correctedScreenshareChunks.length > 0) {
      console.log(`\n✅ SCREENSHARE CHUNKS (first 3):`);
      correctedScreenshareChunks.slice(0, 3).forEach(chunk => {
        const urlSnippet = chunk.url.substring(Math.max(0, chunk.url.length - 60));
        const urlMatch = chunk.url.includes('/screenshare/') ? '✓' : '❌';
        console.log(`  Chunk ${chunk.chunkIndex}: ${urlMatch} ${urlSnippet}`);
      });
    }

    // ✅ Filter chunks by streamType if requested
    let filteredWebcam = correctedWebcamChunks;
    let filteredScreenshare = correctedScreenshareChunks;

    if (streamType === 'webcam') {
      filteredScreenshare = [];
    } else if (streamType === 'screenshare') {
      filteredWebcam = [];
    }

    // Return grouped data structure
    res.json({
      success: true,
      data: {
        webcam: filteredWebcam.map(chunk => ({
          ...chunk,
          sizeBytes: Number(chunk.sizeBytes) // Convert BigInt to Number for JSON
        })),
        screenshare: filteredScreenshare.map(chunk => ({
          ...chunk,
          sizeBytes: Number(chunk.sizeBytes) // Convert BigInt to Number for JSON
        }))
      },
      hlsUrl: getHLSPlaylistUrl(sessionId),
      streamType: streamType || 'all', // Return which stream type was requested
      // Include mismatch warnings in response for debugging
      warnings: {
        webcamMismatches: webcamMismatches.length,
        screenshareMismatches: screenshareMismatches.length
      }
    });

  } catch (error: any) {
    console.error('Error fetching video chunks:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/video/:sessionId/:streamType.m3u8
 * Serve HLS playlist for live streaming (webcam or screenshare)
 */
router.get('/:sessionId/:streamType.m3u8', async (req: Request, res: Response) => {
  try {
    const { sessionId, streamType } = req.params;
    const playlistPath = path.join(process.cwd(), 'uploads', 'hls', sessionId, `${streamType}.m3u8`);

    if (!fs.existsSync(playlistPath)) {
      return res.status(404).json({
        success: false,
        error: 'HLS playlist not found'
      });
    }

    // Set correct content type
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Send playlist file
    const playlist = fs.readFileSync(playlistPath);
    res.send(playlist);

  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;

