import { Router, Request, Response } from 'express';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import { authenticate } from '../middleware/rbac';
import { videoUploadLimiter } from '../middleware/rate-limiter';
import { prisma } from '../lib/prisma';
import { buildCompanyLogoPath, buildRecruiterImagePath, buildCandidateImagePath, getFileExtension } from '../lib/storage-utils';
import { logger } from '../lib/logger';

const router = Router();

// Supabase storage client
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Configure multer for in-memory storage
const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit for images
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

/**
 * POST /api/uploads/profile-image
 * Upload profile avatar (for both recruiters and candidates)
 */
router.post('/profile-image', authenticate, videoUploadLimiter, upload.single('image'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided'
      });
    }

    // Only candidates and recruiters can upload profile images
    if (userRole !== 'candidate' && userRole !== 'recruiter') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only candidates and recruiters can upload profile images.'
      });
    }

    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Supabase storage not configured'
      });
    }

    // Get user name for folder structure
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true }
    });

    const userName = user?.name || `user_${userId}`;
    const timestamp = Date.now();
    const extension = getFileExtension(file.originalname, file.mimetype);

    // Build file path using new folder structure
    // Format: photos/recruiters/{recruiterName}/profile_image_{timestamp}.{ext}
    // Format: photos/candidates/{candidateName}/profile_image_{timestamp}.{ext}
    const filePath = userRole === 'recruiter'
      ? buildRecruiterImagePath(userName, timestamp, extension)
      : buildCandidateImagePath(userName, timestamp, extension);

    try {
      // Upload to Supabase Storage - use "video" as the default bucket name
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';
      const { data, error } = await supabase.storage
        .from(bucket)
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (error) {
        logger.error('Supabase upload error:', error);
        throw error;
      }

      // According to Supabase docs, profile pictures should use PUBLIC buckets
      // Public buckets are more performant and appropriate for public assets
      // Access control is still enforced for upload/delete operations
      // See: https://supabase.com/docs/guides/storage/buckets/fundamentals
      const { data: urlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(filePath);

      const publicUrl = urlData.publicUrl;
      
      // Debug logging
      logger.log('📸 Profile image uploaded successfully');
      logger.log('📸 File path:', filePath);
      logger.log('📸 Bucket:', bucket);
      logger.log('📸 Public URL:', publicUrl);
      logger.log('📸 User ID:', userId);
      logger.log('📸 User role:', userRole);

      res.json({
        success: true,
        data: {
          url: publicUrl,
          filename: filePath.split('/').pop() || 'profile_image.jpg'
        }
      });
    } catch (supabaseError: any) {
      logger.error('Supabase upload failed:', supabaseError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload image to storage'
      });
    }
  } catch (error: any) {
    logger.error('Profile image upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload profile image'
    });
  }
});

/**
 * POST /api/uploads/company-logo
 * Upload company logo
 */
router.post('/company-logo', authenticate, videoUploadLimiter, upload.single('image'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided'
      });
    }

    // Only recruiters can upload company logos
    if (userRole !== 'recruiter') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only recruiters can upload company logos.'
      });
    }

    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Supabase storage not configured'
      });
    }

    // Get recruiter's company name for folder structure
    const recruiterProfile = await prisma.recruiterProfile.findUnique({
      where: { userId },
      include: {
        company: true
      }
    });

    if (!recruiterProfile?.company) {
      return res.status(400).json({
        success: false,
        error: 'Company not found. Please set up your company first.'
      });
    }

    const companyName = recruiterProfile.company.name;
    const timestamp = Date.now();
    const extension = getFileExtension(file.originalname, file.mimetype);

    // Build file path using new folder structure
    // Format: companies/{companyName}/images/company_logo_{timestamp}.{ext}
    const filePath = buildCompanyLogoPath(companyName, timestamp, extension);

    try {
      // Upload to Supabase Storage - use "video" as the default bucket name
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';
      const { data, error } = await supabase.storage
        .from(bucket)
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (error) {
        logger.error('Supabase upload error:', error);
        throw error;
      }

      // According to Supabase docs, company logos should use PUBLIC buckets
      // Public buckets are more performant and appropriate for public assets
      // Access control is still enforced for upload/delete operations
      // See: https://supabase.com/docs/guides/storage/buckets/fundamentals
      const { data: urlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(filePath);

      res.json({
        success: true,
        data: {
          url: urlData.publicUrl,
          filename: filePath.split('/').pop() || 'company_logo.jpg'
        }
      });
    } catch (supabaseError: any) {
      logger.error('Supabase upload failed:', supabaseError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload image to storage'
      });
    }
  } catch (error: any) {
    logger.error('Company logo upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload company logo'
    });
  }
});

export default router;
