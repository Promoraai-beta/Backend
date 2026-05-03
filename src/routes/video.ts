import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { updateHLSPlaylist, getHLSPlaylistUrl } from '../lib/hls';
import { sanitizeName } from '../lib/storage-utils';
import { logger } from '../lib/logger';

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
 * Auto-create the Supabase storage bucket if it doesn't exist.
 * Runs at startup so uploads never fail with "Bucket not found".
 */
async function ensureStorageBucket() {
  if (!supabase) {
    logger.warn('⚠️ Supabase not configured — skipping bucket check');
    return;
  }
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';
  try {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      logger.error('Failed to list Supabase buckets:', listError.message);
      return;
    }
    const exists = buckets?.some((b: { name: string }) => b.name === bucket);
    if (!exists) {
      logger.log(`📦 Supabase bucket "${bucket}" not found — creating it...`);
      const { error: createError } = await supabase.storage.createBucket(bucket, {
        public: true,                         // Public so getPublicUrl works
        fileSizeLimit: 100 * 1024 * 1024,    // 100 MB per file
      });
      if (createError) {
        logger.error(`❌ Failed to create storage bucket "${bucket}":`, createError.message);
      } else {
        logger.log(`✅ Created Supabase storage bucket: "${bucket}"`);
      }
    } else {
      logger.log(`✅ Supabase storage bucket "${bucket}" already exists`);
    }
  } catch (err) {
    logger.error('Error checking/creating Supabase storage bucket:', err);
  }
}

// Run immediately when this module is loaded (backend startup)
ensureStorageBucket();

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
    logger.error(`Chunk ${chunkIndex} (${streamType}): Empty file (0 bytes)`);
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
    logger.warn(`Chunk 0 (${streamType}): Very small (${file.size} bytes), expected larger for WebM header`);
    // Don't reject - still allow upload
  }

  // Validate WebM file format ONLY for chunk 0 (which should have the header)
  // Fragments (chunkIndex > 0) don't have headers - they're just data fragments
  if (chunkIndex === 0 && file.buffer && file.buffer.length >= 4) {
    const magicBytes = file.buffer.slice(0, 4);
    const webmMagic = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);
    
    if (magicBytes.equals(webmMagic)) {
      logger.log(`✅ Chunk 0 (${streamType}): Valid WebM header detected (${file.size} bytes)`);
    } else {
      logger.warn(`Chunk 0 (${streamType}): Missing WebM magic bytes (1A 45 DF A3), got: ${magicBytes.toString('hex')}`);
      logger.warn(`File size: ${file.size} bytes, First 32 bytes: ${file.buffer.slice(0, Math.min(32, file.buffer.length)).toString('hex')}`);
      
      // Check if it's just empty or corrupted data (all zeros)
      const hasNonZeroData = file.buffer.some((byte: number) => byte !== 0);
      if (!hasNonZeroData) {
        logger.error(`Chunk 0 (${streamType}): File contains only zeros - corrupted or empty`);
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
      logger.warn(`Chunk 0 (${streamType}): Missing WebM header, but contains data. Proceeding with upload.`);
    }
  } else if (chunkIndex > 0) {
    // Fragments (chunkIndex > 0) are just data - no header validation needed
    // They can be any size > 0
    logger.log(`✅ Fragment ${chunkIndex} (${streamType}): ${file.size} bytes`);
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
      logger.error(`❌ CRITICAL: Invalid or missing streamType: ${streamType}`);
      return res.status(400).json({
        success: false,
        error: `Invalid or missing streamType. Received: "${streamType}". Must be "webcam" or "screenshare"`
      });
    }
    
    const file = req.file;
    
    // ✅ Log streamType for debugging
    logger.log(`\n📤 Upload request: { sessionId: '${sessionId}', streamType: '${streamType}', chunkIndex: ${chunkIndex} }`);

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
      logger.error(`Rejecting chunk ${chunkIndex} (${streamType}): Empty file (0 bytes)`);
      return res.status(400).json({
        success: false,
        error: `Video chunk is empty (0 bytes)`
      });
    }
    
    // Chunk 0 should be larger, but don't reject if smaller (some MediaRecorder implementations vary)
    if (chunkIndex === 0 && file.size < 100) {
      logger.warn(`Chunk 0 (${streamType}): Very small (${file.size} bytes), but allowing upload`);
      // Don't reject - allow upload
    }
    
    // Fragments (chunkIndex > 0) can be any size > 0 - they're just data fragments
    // Don't reject small fragments - they're valid!

    // Log chunk info for debugging
    logger.log(`📦 Uploading chunk ${chunkIndex} (${streamType}): ${file.size} bytes, MIME: ${file.mimetype || 'video/webm'}`);

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
      logger.error(`❌ CRITICAL: streamType mismatch! Path uses "${streamTypeForPath}" but validated streamType is "${streamType}"`);
      return res.status(500).json({
        success: false,
        error: 'Internal error: streamType mismatch'
      });
    }
    
    // Build deterministic file path (no timestamp) so re-uploads overwrite cleanly
    // Path: companies/{company}/jobs/{job}/{candidate}/{streamType}/chunk_{index}.webm
    const sanitizedCompany = sanitizeName(companyName);
    const sanitizedJob = sanitizeName(jobName);
    const sanitizedCandidate = sanitizeName(candidateName);
    const filePath = `companies/${sanitizedCompany}/jobs/${sanitizedJob}/${sanitizedCandidate}/${streamTypeForPath}/chunk_${chunkIndex}.webm`;

    logger.log(`📁 Uploading ${streamType} chunk ${chunkIndex} → ${filePath}`);

    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Supabase storage not configured'
      });
    }

    let url: string = '';

    try {
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';

      // Retry logic with upsert:true so re-uploads overwrite without needing to delete first
      let uploadSuccess = false;
      let lastError: any = null;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 1) {
            logger.log(`Retry attempt ${attempt}/${maxRetries} for ${filePath}`);
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }

          const { error } = await supabase.storage
            .from(bucket)
            .upload(filePath, file.buffer, {
              contentType: 'video/webm',
              upsert: true  // Overwrite if same chunk re-uploaded — no stale duplicates
            });

          if (error) {
            logger.error(`Upload attempt ${attempt} error:`, error);
            throw error;
          }

          const { data: urlData } = supabase.storage
            .from(bucket)
            .getPublicUrl(filePath);

          url = urlData.publicUrl;
          uploadSuccess = true;
          logger.log(`✅ Uploaded chunk ${chunkIndex} (${streamType}): ${filePath}`);
          break;
        } catch (retryError: any) {
          lastError = retryError;
        }
      }

      if (!uploadSuccess) {
        throw lastError || new Error('Upload failed after retries');
      }

    } catch (supabaseError) {
      logger.error('Supabase upload failed:', supabaseError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload video to storage'
      });
    }

    // No DB write needed — S3 is the single source of truth.
    // The GET route lists chunks directly from Supabase Storage.

    res.json({
      success: true,
      data: {
        sessionId,
        chunkIndex,
        streamType,
        url,
        sizeBytes: file.size,
      },
      message: 'Video chunk uploaded successfully'
    });

  } catch (error: any) {
    logger.error('Video upload error:', error);
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
    const { streamType } = req.query;

    logger.log(`\n📥 GET /api/video/${sessionId}`);

    if (!supabase) {
      return res.status(500).json({ success: false, error: 'Supabase storage not configured' });
    }

    // Look up session to reconstruct the S3 folder path
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { assessment: { include: { company: true } } }
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const companyName = session.assessment?.company?.name || 'UnknownCompany';
    const jobName = session.assessment?.jobTitle || session.assessment?.role || 'UnknownJob';
    const candidateName = session.candidateName || session.sessionCode || 'UnknownCandidate';

    const sanitizedCompany = sanitizeName(companyName);
    const sanitizedJob = sanitizeName(jobName);
    const sanitizedCandidate = sanitizeName(candidateName);
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';

    /**
     * List chunks for one stream type directly from Supabase Storage.
     * Files are named chunk_0.webm, chunk_1.webm, … so we parse the index
     * from the filename and sort numerically.
     */
    const listChunks = async (st: 'webcam' | 'screenshare') => {
      const prefix = `companies/${sanitizedCompany}/jobs/${sanitizedJob}/${sanitizedCandidate}/${st}`;
      const { data: files, error } = await supabase!.storage
        .from(bucket)
        .list(prefix, { limit: 2000, sortBy: { column: 'name', order: 'asc' } });

      if (error || !files) {
        logger.warn(`⚠️ Could not list ${st} chunks: ${error?.message}`);
        return [];
      }

      return files
        .filter(f => f.name.endsWith('.webm'))
        .map(f => {
          // Supports both naming conventions:
          //   chunk_0.webm          (new — deterministic)
          //   chunk_0_1712345.webm  (old — with timestamp)
          const match = f.name.match(/^chunk_(\d+)(?:_\d+)?\.webm$/);
          const chunkIndex = match ? parseInt(match[1], 10) : -1;
          const filePath = `${prefix}/${f.name}`;
          const { data: urlData } = supabase!.storage.from(bucket).getPublicUrl(filePath);
          return {
            chunkIndex,
            streamType: st,
            url: urlData.publicUrl,
            sizeBytes: f.metadata?.size ?? 0,
          };
        })
        .filter(c => c.chunkIndex >= 0)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
    };

    const [webcamChunks, screenshareChunks] = await Promise.all([
      streamType === 'screenshare' ? [] : listChunks('webcam'),
      streamType === 'webcam'      ? [] : listChunks('screenshare'),
    ]);

    logger.log(`📊 Found ${webcamChunks.length} webcam chunks, ${screenshareChunks.length} screenshare chunks`);

    res.json({
      success: true,
      data: { webcam: webcamChunks, screenshare: screenshareChunks },
      hlsUrl: getHLSPlaylistUrl(sessionId),
      streamType: streamType || 'all',
      warnings: { webcamMismatches: 0, screenshareMismatches: 0 }
    });

  } catch (error: any) {
    logger.error('Error fetching video chunks:', error);
    res.status(500).json({ success: false, error: error.message });
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

