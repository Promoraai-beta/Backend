import { Router, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { prisma } from '../lib/prisma';
import { containerManager } from '../services/container-manager';
import { generateSecureSessionCode } from '../lib/session-code';
import { validateSessionCreation, handleValidationErrors } from '../middleware/validation';
import { apiLimiter, sessionCodeLimiter } from '../middleware/rate-limiter';
import { validateSessionCodeSecurity, enforceTimer } from '../middleware/security';
import { checkSessionInactivity } from '../services/inactivity-monitor';
import { authenticate, checkSessionOwnership, optionalAuthenticate, requireRole } from '../middleware/rbac';
import * as jwt from 'jsonwebtoken';
import { sendEmail, generateAssessmentEmail } from '../lib/email';
import multer from 'multer';
import { logger } from '../lib/logger';

const router = Router();

// Configure multer for CSV file upload (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Create session
// Allow both authenticated (recruiters/candidates) and unauthenticated (public) session creation
// SECURITY: Candidates cannot create sessions for recruiter assessments
router.post('/', apiLimiter, optionalAuthenticate, validateSessionCreation, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { candidate_name, candidate_email, recruiter_email, time_limit, expires_at, assessment_id, candidate_id, status } = req.body;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    // SECURITY CHECK: If assessment_id is provided, verify it's accessible
    if (assessment_id) {
      const assessment = await prisma.assessment.findUnique({
        where: { id: assessment_id },
        select: { assessmentType: true, createdBy: true, companyId: true }
      });

      if (!assessment) {
        return res.status(404).json({
          success: false,
          error: 'Assessment not found'
        });
      }

      // SECURITY: Candidates cannot create sessions for recruiter assessments
      if (userRole === 'candidate' && assessment.assessmentType === 'recruiter') {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Candidates cannot create sessions for recruiter assessments. Only recruiters can assign recruiter assessments to candidates.'
        });
      }

      // SECURITY: If candidate is creating a session, ensure it's only for their own candidate assessments
      if (userRole === 'candidate' && assessment.assessmentType === 'candidate') {
        if (assessment.createdBy !== userId) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. You can only create sessions for your own candidate assessments.'
          });
        }
      }

      // SECURITY: Unauthenticated users cannot create sessions for candidate assessments
      // Only recruiters can create sessions for recruiter assessments (which are then shared with candidates)
      if (!userId && assessment.assessmentType === 'candidate') {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Candidate assessments can only be accessed by authenticated candidates.'
        });
      }
    }

    // If candidate is authenticated, use their user ID
    let finalCandidateId = candidate_id;
    let finalCandidateEmail = candidate_email;
    let finalCandidateName = candidate_name;

    if (userRole === 'candidate' && userId) {
      finalCandidateId = userId;
      // Get candidate info from user
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });
      if (user) {
        finalCandidateEmail = candidate_email || user.email;
        finalCandidateName = candidate_name || user.name;
      }
    }

    // Generate secure session code server-side
    let sessionCode = generateSecureSessionCode();
    
    // Ensure code is unique (retry if collision, max 10 attempts)
    let attempts = 0;
    while (attempts < 10) {
      const existing = await prisma.session.findUnique({
        where: { sessionCode }
      });
      
      if (!existing) {
        break; // Code is unique
      }
      
      sessionCode = generateSecureSessionCode();
      attempts++;
    }
    
    if (attempts >= 10) {
      return res.status(500).json({
        success: false,
        error: 'Failed to generate unique session code. Please try again.'
      });
    }

    const data = await prisma.session.create({
      data: {
        sessionCode: sessionCode,
        candidateId: finalCandidateId || null,
        candidateName: finalCandidateName || null,
        candidateEmail: finalCandidateEmail || null,
        recruiterEmail: recruiter_email || null,
        assessmentId: assessment_id || null,
        timeLimit: time_limit || 3600,
        expiresAt: expires_at ? new Date(expires_at) : null,
        status: status || 'pending'
      },
      include: {
        assessment: {
          include: {
            company: true
          }
        }
      }
    });

    // If this is a recruiter creating a session for a candidate, send invitation email
    if (userRole === 'recruiter' && assessment_id && finalCandidateEmail) {
      try {
        const recruiterProfile = await prisma.recruiterProfile.findUnique({
          where: { userId: userId || '' },
          include: {
            company: true,
            user: true
          }
        });

        if (recruiterProfile && data.assessment) {
          const companyName = data.assessment.company?.name || recruiterProfile.company?.name || 'Our Company';
          const recruiterName = recruiterProfile.user?.name || 'Recruiter';
          const jobTitle = data.assessment.jobTitle || data.assessment.role || undefined;
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
          const assessmentUrl = `${frontendUrl}/assessment/${sessionCode}`;
          const timeLimitMinutes = data.timeLimit ? Math.floor(data.timeLimit / 60) : undefined;

          const emailOptions = generateAssessmentEmail(
            finalCandidateName || finalCandidateEmail.split('@')[0],
            finalCandidateEmail,
            companyName,
            recruiterName,
            sessionCode,
            assessmentUrl,
            jobTitle,
            timeLimitMinutes,
            data.expiresAt || undefined
          );

          // Send email in background (don't wait for it)
          sendEmail(emailOptions).catch((error) => {
            logger.error('Failed to send invitation email:', error);
            // Don't fail the request if email fails
          });
        }
      } catch (emailError) {
        logger.error('Error sending invitation email:', emailError);
        // Don't fail the request if email fails
      }
    }

    res.json({ success: true, data });
  } catch (error: any) {
    logger.error('Session creation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all sessions
// SECURITY: Candidates can only see sessions assigned to them (recruiter assessments) or their own candidate assessments
router.get('/', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { candidate_email, status } = req.query;
    
    // Try to get user from token (optional authentication)
    let userId: string | undefined;
    let userRole: string | undefined;
    let companyId: string | undefined;
    
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
        try {
          const decoded = jwt.verify(token, JWT_SECRET) as any;
          userId = decoded.userId;
          userRole = decoded.role;
          
          // If recruiter, get their company
          if (userRole === 'recruiter' && userId) {
            const recruiterProfile = await prisma.recruiterProfile.findUnique({
              where: { userId: userId },
              include: { company: true }
            });
            companyId = recruiterProfile?.companyId || undefined;
          }
        } catch (verifyError) {
          // Token invalid - continue without authentication
        }
      }
    } catch (e) {
      // Token invalid or missing - continue without authentication
    }
    
    // Build where clause for filtering
    const where: any = {};
    if (candidate_email) {
      where.candidateEmail = candidate_email as string;
    }
    if (status) {
      where.status = status as string;
    }
    
    // SECURITY: If recruiter is authenticated, filter sessions by their company's assessments
    if (userRole === 'recruiter' && companyId) {
      where.assessment = {
        companyId: companyId,
        assessmentType: 'recruiter' // Only recruiter assessments
      };
    } else if (userRole === 'recruiter' && userId) {
      // Recruiter without company - show sessions for assessments they created
      where.assessment = {
        createdBy: userId,
        assessmentType: 'recruiter'
      };
    }
    
    // SECURITY: If candidate is authenticated, only show:
    // 1. Sessions assigned to them (candidateId matches) - these are recruiter assessments
    // 2. Sessions for their own candidate assessments
    if (userRole === 'candidate' && userId) {
      where.OR = [
        // Sessions assigned to this candidate (recruiter assessments)
        { candidateId: userId },
        // Sessions for candidate assessments created by this candidate
        {
          assessment: {
            assessmentType: 'candidate',
            createdBy: userId
          }
        }
      ];
    }
    
    const data = await prisma.session.findMany({
      where,
      include: {
        assessment: {
          include: {
            company: true
          }
        }
      },
      orderBy: {
        startedAt: 'desc'
      }
    });

    // SECURITY: Filter out assessment details for candidates viewing recruiter assessments
    // Candidates should see session info but not full assessment template until they start
    const filteredData = data.map(session => {
      if (userRole === 'candidate' && session.assessment?.assessmentType === 'recruiter') {
        // For recruiter assessments, only return basic assessment info (not full template)
        return {
          ...session,
          assessment: session.assessment ? {
            id: session.assessment.id,
            jobTitle: session.assessment.jobTitle,
            role: session.assessment.role,
            level: session.assessment.level,
            company: session.assessment.company?.name || null,
            // Don't expose template, techStack, or other sensitive details
            assessmentType: session.assessment.assessmentType
          } : null
        };
      }
      return session;
    });

    res.json({ success: true, data: filteredData });
  } catch (error: any) {
    logger.error('Error fetching sessions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get session by ID
// SECURITY: Requires authentication and ownership check
router.get('/:id', optionalAuthenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { id } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    const data = await prisma.session.findUnique({
      where: { id },
      include: {
        assessment: {
          include: {
            company: true
          }
        }
      }
    });

    if (!data) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // SECURITY: Check access based on user role
    if (userRole === 'candidate') {
      // Candidates can only access:
      // 1. Sessions assigned to them (candidateId matches)
      // 2. Sessions for their own candidate assessments
      if (data.candidateId !== userId) {
        // Check if it's a candidate assessment they created
        if (data.assessment?.assessmentType !== 'candidate' || data.assessment?.createdBy !== userId) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. This session is not assigned to you.'
          });
        }
      }
      
      // SECURITY: If it's a recruiter assessment, don't expose full template until session starts
      if (data.assessment?.assessmentType === 'recruiter' && data.status === 'pending') {
        return res.json({
          success: true,
          data: {
            ...data,
            assessment: data.assessment ? {
              id: data.assessment.id,
              jobTitle: data.assessment.jobTitle,
              role: data.assessment.role,
              level: data.assessment.level,
              company: data.assessment.company?.name || null,
              assessmentType: data.assessment.assessmentType
              // Don't expose template, techStack, etc.
            } : null
          }
        });
      }
    } else if (userRole === 'recruiter') {
      // Recruiters can only access sessions for their company's recruiter assessments
      if (data.assessment?.assessmentType !== 'recruiter') {
        return res.status(403).json({
          success: false,
          error: 'Access denied. This is a candidate assessment session.'
        });
      }
      
      const recruiterProfile = await prisma.recruiterProfile.findUnique({
        where: { userId: userId || '' }
      });
      
      if (recruiterProfile?.companyId !== data.assessment?.companyId && data.assessment?.createdBy !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You do not have permission to access this session.'
        });
      }
    } else if (!userId) {
      // Unauthenticated users can only access sessions if they have the session code
      // This endpoint should not be used without authentication for security
      return res.status(401).json({
        success: false,
        error: 'Authentication required to access sessions by ID. Use session code endpoint instead.'
      });
    }

    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get session by code (with assessment template)
// Public endpoint but rate-limited and validated
// SECURITY: Only allows access to recruiter assessments (candidates take these via session code)
// Candidate assessments require authentication
router.get('/code/:code', sessionCodeLimiter, validateSessionCodeSecurity, optionalAuthenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const session = (req as any).session; // Already validated by middleware
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    const data = await prisma.session.findUnique({
      where: {
        sessionCode: session.sessionCode
      },
      include: {
        assessment: {
          include: {
            company: true
          }
        }
      }
    });

    if (!data) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // SECURITY: Block access to ended/completed sessions
    // Sessions with status 'submitted', 'ended', or 'completed' cannot be accessed again
    if (data.status === 'submitted' || data.status === 'ended' || data.status === 'completed') {
      return res.status(403).json({
        success: false,
        error: 'This session has ended and is no longer accessible. The assessment has been submitted.',
        sessionStatus: data.status,
        submittedAt: data.submittedAt
      });
    }

    // SECURITY: Check for inactivity timeout before allowing access
    // This ensures sessions that have been inactive for 15+ minutes are automatically ended
    if (data.status === 'active') {
      const inactivityCheck = await checkSessionInactivity(data.id);
      if (inactivityCheck.inactive) {
        // Session was ended due to inactivity - refresh data to get updated status
        const updatedSession = await prisma.session.findUnique({
          where: { id: data.id },
          select: { status: true, submittedAt: true }
        });
        
        if (updatedSession && (updatedSession.status === 'ended' || updatedSession.status === 'submitted')) {
          return res.status(403).json({
            success: false,
            error: 'This session has ended due to inactivity (15 minutes of no activity). The session is no longer accessible.',
            sessionStatus: updatedSession.status,
            submittedAt: updatedSession.submittedAt,
            reason: 'inactivity_timeout'
          });
        }
      }
    }

    // Check if assessment exists
    if (!data.assessment) {
      return res.status(404).json({ success: false, error: 'Assessment not found for this session' });
    }

    // Determine assessment type
    // Heuristics to identify recruiter assessments:
    // 1. Explicit assessmentType === 'recruiter'
    // 2. Assessment has companyId (recruiter assessments belong to companies)
    // 3. Session has recruiterEmail (created by recruiter)
    // 4. Assessment type is null/undefined (default to recruiter for backwards compatibility)
    let assessmentType = data.assessment.assessmentType;
    const hasCompanyId = !!data.assessment.companyId;
    const hasRecruiterEmail = !!data.recruiterEmail;
    
    // If assessment type is not set, infer from context
    if (!assessmentType) {
      // Default to recruiter if it has companyId or recruiterEmail (indicating recruiter-created session)
      assessmentType = (hasCompanyId || hasRecruiterEmail) ? 'recruiter' : 'candidate';
    }
    // If assessment type is 'candidate' but has recruiterEmail/companyId, it's likely a misclassification
    // Treat as recruiter assessment if session was created by recruiter (has recruiterEmail)
    else if (assessmentType === 'candidate' && (hasRecruiterEmail || hasCompanyId)) {
      logger.warn(`[Session Access] Assessment ${data.assessment.id} marked as 'candidate' but has recruiter indicators. Treating as recruiter assessment.`);
      assessmentType = 'recruiter';
    }
    
    // Log for debugging
    logger.log(`[Session Access] Session ${data.id}, Assessment Type: ${assessmentType}, Original Type: ${data.assessment.assessmentType}, HasCompanyId: ${hasCompanyId}, HasRecruiterEmail: ${hasRecruiterEmail}, User: ${userId || 'anonymous'}, Role: ${userRole || 'none'}`);

    // SECURITY: Handle recruiter assessments first (these are accessible via session code)
    // Recruiter assessments can be accessed by anyone with the session code
    // This is the intended behavior - recruiters create sessions and share codes with candidates
    if (assessmentType === 'recruiter') {
      // For recruiter assessments accessed via session code, allow access regardless of authentication
      // The session code itself is the authentication mechanism
      // If candidate is authenticated and session doesn't have candidateId, link it to their account
      if (userId && userRole === 'candidate' && !data.candidateId) {
        // Update session to link it to the authenticated candidate (if email matches)
        try {
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { email: true }
          });
          
          // Only link if email matches (or if no email was set in session)
          if (!data.candidateEmail || (user?.email && user.email === data.candidateEmail)) {
            await prisma.session.update({
              where: { id: data.id },
              data: { candidateId: userId }
            });
            // Refresh data to include the linked candidateId
            const updatedSession = await prisma.session.findUnique({
              where: { sessionCode: session.sessionCode },
              include: {
                assessment: {
                  include: {
                    company: true
                  }
                }
              }
            });
            if (updatedSession) {
              Object.assign(data, updatedSession);
            }
          }
        } catch (error) {
          // If update fails, continue anyway - session code is still valid
          logger.warn('Failed to link session to candidate:', error);
        }
      }
      // Always allow access to recruiter assessments via session code
      // No additional authentication checks needed - session code is sufficient
      // Continue to return the session data below
    } 
    // SECURITY: Candidate assessments can only be accessed by authenticated candidates who created them
    else if (assessmentType === 'candidate') {
      // Only enforce authentication for candidate assessments if they were explicitly created as candidate type
      if (!userId || userRole !== 'candidate' || data.assessment.createdBy !== userId) {
        logger.log(`[Session Access Denied] Candidate assessment access denied for session ${data.id}. User: ${userId}, Role: ${userRole}, CreatedBy: ${data.assessment.createdBy}`);
        return res.status(403).json({
          success: false,
          error: 'Access denied. Candidate assessments require authentication and can only be accessed by the creator.'
        });
      }
    }

      // Include assessment template in response
      const response: any = { ...data };
      if (data.assessment) {
        // Template is stored as JSON, ensure it's parsed correctly
        let template = data.assessment.template;
        if (typeof template === 'string') {
          try {
            template = JSON.parse(template);
          } catch (e) {
            logger.error('Failed to parse assessment template:', e);
            template = null;
          }
        }
        
        // Extract suggestedAssessments (agent-generated tasks) from template
        let suggestedAssessments = [];
        if (template && typeof template === 'object') {
          if ('suggestedAssessments' in template) {
            suggestedAssessments = (template as any).suggestedAssessments || [];
          } else if (Array.isArray(template)) {
            // If template is directly an array (legacy format)
            suggestedAssessments = template;
          }
        }
        
        // Set assessmentTemplate to the suggestedAssessments array (agent-generated tasks)
        response.assessmentTemplate = suggestedAssessments;
        response.assessmentMeta = {
          role: data.assessment.role,
          level: data.assessment.level,
          techStack: Array.isArray(data.assessment.techStack) ? data.assessment.techStack : [],
          jobTitle: data.assessment.jobTitle,
          company: data.assessment.company?.name || null
        };
        
        // Extract template spec for template files
        // Check if template spec is stored in assessment
        if (template && typeof template === 'object' && 'templateSpec' in template) {
          const templateSpec = (template as any).templateSpec;
          if (templateSpec && templateSpec.fileStructure) {
            response.templateFiles = templateSpec.fileStructure;
            logger.log('📁 Including template files in session response');
          }
        }
        
        logger.log('📋 Session API: Sending assessment template:', {
          hasTemplate: !!template,
          suggestedAssessmentsCount: suggestedAssessments.length,
          templateType: typeof template,
          meta: response.assessmentMeta
        });
      }

    res.json({ success: true, data: response });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start session
router.post('/:id/start', enforceTimer, async (req: ExpressRequest, res: ExpressResponse) => {
  const startTime = Date.now(); // Track response time
  try {
    const { id } = req.params;

    // Get session with assessment and template reference
    const session = await prisma.session.findUnique({
      where: { id },
      include: {
        assessment: {
          include: {
            company: true,
            templateRef: true // Include reusable template if available
          }
        }
      }
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Update session status and re-fetch with assessment to ensure assessmentType is included
    const data = await prisma.session.update({
      where: { id },
      data: {
        status: 'active',
        startedAt: new Date()
      },
      include: {
        assessment: {
          include: {
            company: true,
            templateRef: true // Include reusable template if available
          }
        }
      }
    });

    // Extract template files IMMEDIATELY from assessment data (don't wait for containers)
    // Template files are already stored in the assessment, so we can return them right away
    let templateFiles: Record<string, string> | null = null;
    let containerInfo: any = null;
    let needsContainer = false; // Only true for IDE challenges
    let template: any = null; // Declare template in outer scope
    
    if (data.assessment) {
      // PRIORITY 1: Try to get template from templateRef (reusable template)
      // PRIORITY 2: Fall back to inline template storage (legacy)
      let templateSpec = null;
      let suggestedAssessments = null;
      
      // Check if assessment has a template reference (new reusable template system)
      if (data.assessment.templateRef) {
        const templateRef = data.assessment.templateRef;
        templateSpec = templateRef.templateSpec as any;
        const refSuggestedAssessments = templateRef.suggestedAssessments;
        suggestedAssessments = Array.isArray(refSuggestedAssessments) ? refSuggestedAssessments : null;
        logger.log(`📦 Using reusable template: ${templateRef.templateHash?.substring(0, 8)}... (usage: ${templateRef.usageCount})`);
      } else {
        // Fall back to inline template (legacy)
        let assessmentTemplate = data.assessment.template;
        if (typeof assessmentTemplate === 'string') {
          try {
            assessmentTemplate = JSON.parse(assessmentTemplate);
          } catch (e) {
            logger.error('Failed to parse assessment template:', e);
            assessmentTemplate = null;
          }
        }
        template = assessmentTemplate; // Store for later use
        
        // Try to extract template spec from assessment
        if (assessmentTemplate && typeof assessmentTemplate === 'object') {
          // Template spec might be nested in the template object
          if ('templateSpec' in assessmentTemplate) {
            templateSpec = (assessmentTemplate as any).templateSpec;
            suggestedAssessments = (assessmentTemplate as any).suggestedAssessments;
          }
          // Also check if templateSpec is at root level (if template is the templateSpec itself)
          else if ('fileStructure' in assessmentTemplate) {
            templateSpec = assessmentTemplate;
          }
        }
      }

      // Extract file structure IMMEDIATELY (no waiting)
      if (templateSpec && templateSpec.fileStructure) {
        templateFiles = templateSpec.fileStructure;
        logger.log(`📁 Extracted ${templateFiles ? Object.keys(templateFiles).length : 0} template files immediately from ${data.assessment.templateRef ? 'reusable template' : 'inline template'}`);
        // If we have template files, this is likely an IDE challenge that needs a container
        needsContainer = templateFiles !== null && Object.keys(templateFiles).length > 0;
      } else {
        logger.log('ℹ️ No template files found in assessment (code challenge or template files not stored)');
      }

      // Only provision container for IDE challenges (which have templateFiles)
      // Code challenges don't need containers, so skip provisioning for them
      if (needsContainer) {
        // Provision container ASYNCHRONOUSLY (don't block the response)
        // This allows the candidate to start immediately with template files
        
        // Use Docker image from template if available, otherwise construct from assessment
        let templateImage: string;
        let templateId: string;
        
        // Check if we have a reusable template with Docker image
        const templateRef = data.assessment.templateRef;
        if (templateRef?.dockerImage) {
          templateImage = templateRef.dockerImage;
          templateId = templateRef.id;
          logger.log(`🐳 Using Docker image from reusable template: ${templateImage}`);
        } else {
          // Fall back to constructing image name (legacy)
          const role = data.assessment.role?.toLowerCase() || 'general';
          const stack = Array.isArray(data.assessment.techStack) 
            ? data.assessment.techStack.join('-').toLowerCase()
            : 'general';
          const level = data.assessment.level?.toLowerCase() || 'mid';
          templateImage = `promora/${role}-${stack}-${level}:latest`;
          templateId = templateRef?.id || `template-${data.assessment.id}`;
          logger.log(`🐳 Constructed Docker image name: ${templateImage} (template not found or no Docker image)`);
        }

        // Start container provisioning in background (non-blocking)
        containerManager.createSessionContainer(id, templateImage, templateId)
          .then(container => {
            logger.log(`✅ Container provisioned asynchronously for session ${id}:`, container.containerId);
            // TODO: Optionally update session with container info via WebSocket or polling
          })
          .catch(error => {
            logger.error(`⚠️ Failed to provision container in background (continuing without): ${error.message}`);
            // Container provisioning failure doesn't block session start
            // Candidate can still work with template files
          });
        
        // Return placeholder container info (will be updated when ready)
        containerInfo = {
          status: 'provisioning',
          message: 'Container is being provisioned in the background'
        };
      } else {
        logger.log(`⏩ Skipping container provisioning for code challenge (no template files needed)`);
      }
    }

    // Include assessment template in response (same as /code/:code endpoint)
    // Return template files immediately (they're already in the assessment data)
    const response: any = {
      ...data,
      // Include template files at root level for immediate access
      templateFiles: templateFiles || null,
      // Container info (may be provisioning in background)
      container: containerInfo ? {
        ...containerInfo,
        templateFiles: templateFiles // Also include in container for backward compatibility
      } : null
    };

    // Add assessment template and meta if assessment exists
    if (data.assessment) {
      // Get suggestedAssessments from templateRef (reusable template) or inline template (legacy)
      let suggestedAssessments = [];
      
      // Check if assessment has a template reference (new reusable template system)
      if (data.assessment.templateRef) {
        const templateRef = data.assessment.templateRef;
        const refSuggestedAssessments = templateRef.suggestedAssessments;
        suggestedAssessments = Array.isArray(refSuggestedAssessments) ? refSuggestedAssessments : [];
      } else {
        // Fall back to inline template (legacy) - use template variable if available
        if (!template) {
          template = data.assessment.template;
          if (typeof template === 'string') {
            try {
              template = JSON.parse(template);
            } catch (e) {
              logger.error('Failed to parse assessment template:', e);
              template = null;
            }
          }
        }
        
        // Extract suggestedAssessments (agent-generated tasks) from template
        if (template && typeof template === 'object') {
          if ('suggestedAssessments' in template) {
            suggestedAssessments = (template as any).suggestedAssessments || [];
          } else if (Array.isArray(template)) {
            // If template is directly an array (legacy format)
            suggestedAssessments = template;
          }
        }
      }
      
      // Set assessmentTemplate to the suggestedAssessments array
      response.assessmentTemplate = suggestedAssessments;
      response.assessmentMeta = {
        role: data.assessment.role,
        level: data.assessment.level,
        techStack: Array.isArray(data.assessment.techStack) ? data.assessment.techStack : [],
        jobTitle: data.assessment.jobTitle,
        company: data.assessment.company?.name || null
      };

      // Also include templateFiles at root level if not in container
      if (!templateFiles && template && typeof template === 'object' && 'templateSpec' in template) {
        const templateSpec = (template as any).templateSpec;
        if (templateSpec && templateSpec.fileStructure) {
          response.templateFiles = templateSpec.fileStructure;
        }
      }

      logger.log('📋 Session start: Including assessment template:', {
        hasTemplate: !!template,
        suggestedAssessmentsCount: suggestedAssessments.length,
        templateFilesCount: response.templateFiles ? Object.keys(response.templateFiles).length : 0,
        containerStatus: containerInfo?.status || 'not_needed',
        meta: response.assessmentMeta
      });
    }

    const responseTime = Date.now() - startTime;
    logger.log(`⚡ Session start response ready in ${responseTime}ms (container provisioning: ${needsContainer ? 'background' : 'skipped'})`);

    res.json({ 
      success: true, 
      data: response
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// Track activity - update lastActivityAt timestamp
router.post('/:id/activity', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { id } = req.params;

    const session = await prisma.session.findUnique({
      where: { id }
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Only update activity for active sessions
    if (session.status !== 'active') {
      return res.json({ 
        success: true, 
        message: 'Session is not active, activity not tracked',
        status: session.status 
      });
    }

    // Update last activity timestamp
    await prisma.session.update({
      where: { id },
      data: {
        lastActivityAt: new Date()
      }
    });

    res.json({ success: true, message: 'Activity tracked' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Track tab switch
router.post('/:id/tab-switch', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { id } = req.params;
    const MAX_TAB_SWITCHES = parseInt(process.env.MAX_TAB_SWITCHES || '5', 10);

    const session = await prisma.session.findUnique({
      where: { id }
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Only track tab switches for active sessions
    if (session.status !== 'active') {
      return res.json({ 
        success: true, 
        message: 'Session is not active, tab switch not tracked',
        status: session.status 
      });
    }

    // Increment tab switch count
    const newTabSwitchCount = (session.tabSwitchCount || 0) + 1;
    
    // Check if tab switch limit exceeded
    if (newTabSwitchCount >= MAX_TAB_SWITCHES) {
      // Auto-end session due to excessive tab switching
      await prisma.session.update({
        where: { id },
        data: {
          status: 'ended',
          submittedAt: new Date(),
          tabSwitchCount: newTabSwitchCount,
          lastTabSwitchAt: new Date()
        }
      });

      return res.status(403).json({
        success: false,
        error: 'Session ended due to excessive tab switching',
        sessionEnded: true,
        reason: 'tab_switching'
      });
    }

    // Update tab switch tracking
    await prisma.session.update({
      where: { id },
      data: {
        tabSwitchCount: newTabSwitchCount,
        lastTabSwitchAt: new Date(),
        lastActivityAt: new Date() // Also update activity on tab switch
      }
    });

    res.json({ 
      success: true, 
      tabSwitchCount: newTabSwitchCount,
      maxTabSwitches: MAX_TAB_SWITCHES,
      remaining: MAX_TAB_SWITCHES - newTabSwitchCount
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// End session
router.post('/:id/end', enforceTimer, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { id } = req.params;

    // Check current session status - don't update if already ended
    const current = await prisma.session.findUnique({
      where: { id }
    });

    if (!current) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Only update if session is still active or pending
    if (current.status === 'active' || current.status === 'pending') {
      const data = await prisma.session.update({
        where: { id },
        data: {
          status: 'submitted',
          submittedAt: new Date()
        }
      });

      res.json({ success: true, data });
    } else {
      // Already ended, return existing data
      res.json({ success: true, data: current, message: 'Session already ended' });
    }
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/sessions/bulk
 * Create multiple sessions from CSV file and send bulk emails
 * Requires: recruiter authentication
 */
router.post('/bulk', authenticate, requireRole(['recruiter']), upload.single('csv'), async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'CSV file is required'
      });
    }

    const { assessment_id, time_limit, expires_at } = req.body;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    if (!assessment_id) {
      return res.status(400).json({
        success: false,
        error: 'Assessment ID is required'
      });
    }

    // Verify assessment exists and belongs to recruiter's company
    const assessment = await prisma.assessment.findUnique({
      where: { id: assessment_id },
      include: {
        company: true
      }
    });

    if (!assessment) {
      return res.status(404).json({
        success: false,
        error: 'Assessment not found'
      });
    }

    // SECURITY: Verify recruiter has access to this assessment
    if (assessment.assessmentType !== 'recruiter') {
      return res.status(403).json({
        success: false,
        error: 'Only recruiter assessments can be used for bulk session creation'
      });
    }

    const recruiterProfile = await prisma.recruiterProfile.findUnique({
      where: { userId: userId || '' },
      include: {
        company: true,
        user: true
      }
    });

    if (!recruiterProfile) {
      return res.status(403).json({
        success: false,
        error: 'Recruiter profile not found'
      });
    }

    // Check if recruiter has access to this assessment
    if (assessment.companyId && recruiterProfile.companyId !== assessment.companyId && assessment.createdBy !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. You do not have permission to use this assessment.'
      });
    }

    // Parse CSV file
    const csvContent = file.buffer.toString('utf-8');
    const lines = csvContent.split('\n').filter((line: string) => line.trim());
    
    if (lines.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'CSV file must contain at least a header row and one data row'
      });
    }

    // Parse CSV header to find email column
    const header = lines[0].split(',').map((h: string) => h.trim().toLowerCase());
    const emailIndex = header.findIndex((h: string) => h.includes('email') || h === 'email' || h === 'e-mail');
    const nameIndex = header.findIndex((h: string) => h.includes('name') || h === 'name' || h === 'full name' || h === 'fullname' || h === 'candidate name');

    if (emailIndex === -1) {
      return res.status(400).json({
        success: false,
        error: 'CSV file must contain an email column'
      });
    }

    // Extract emails from CSV
    const candidates: Array<{ email: string; name?: string }> = [];
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map((v: string) => v.trim().replace(/^"|"$/g, '')); // Remove quotes
      const email = values[emailIndex]?.toLowerCase().trim();
      const name = nameIndex !== -1 ? values[nameIndex]?.trim() : undefined;

      if (email && emailRegex.test(email)) {
        candidates.push({ email, name });
      }
    }

    if (candidates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid email addresses found in CSV file'
      });
    }

    // Remove duplicates
    const uniqueCandidates = Array.from(
      new Map(candidates.map(c => [c.email, c])).values()
    );

    // Get company info
    const companyName = assessment.company?.name || recruiterProfile.company?.name || 'Our Company';
    const recruiterName = recruiterProfile.user?.name || 'Recruiter';
    const jobTitle = assessment.jobTitle || assessment.role || 'the position';

    // Calculate expiry date
    const expiresAt = expires_at ? new Date(expires_at) : (() => {
      const date = new Date();
      date.setHours(date.getHours() + 24);
      return date;
    })();

    const timeLimit = time_limit ? parseInt(time_limit, 10) : 3600;

    // Create sessions and send emails
    const results = {
      total: uniqueCandidates.length,
      created: 0,
      failed: 0,
      emailsSent: 0,
      emailsFailed: 0,
      errors: [] as string[]
    };

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    for (const candidate of uniqueCandidates) {
      try {
        // Generate secure session code
        let sessionCode = generateSecureSessionCode();
        let attempts = 0;
        while (attempts < 10) {
          const existing = await prisma.session.findUnique({
            where: { sessionCode }
          });
          if (!existing) break;
          sessionCode = generateSecureSessionCode();
          attempts++;
        }

        if (attempts >= 10) {
          results.failed++;
          results.errors.push(`Failed to generate unique session code for ${candidate.email}`);
          continue;
        }

        // Create session
        const session = await prisma.session.create({
          data: {
            sessionCode,
            candidateEmail: candidate.email,
            candidateName: candidate.name || candidate.email.split('@')[0],
            assessmentId: assessment_id,
            timeLimit,
            expiresAt,
            status: 'pending',
            recruiterEmail: recruiterProfile.user?.email || null
          },
          include: {
            assessment: {
              include: {
                company: true
              }
            }
          }
        });

        results.created++;

        // Send email
        const assessmentUrl = `${frontendUrl}/assessment/${sessionCode}`;
        const timeLimitMinutes = timeLimit ? Math.floor(timeLimit / 60) : undefined;
        const emailOptions = generateAssessmentEmail(
          candidate.name || candidate.email.split('@')[0],
          candidate.email,
          companyName,
          recruiterName,
          sessionCode,
          assessmentUrl,
          jobTitle,
          timeLimitMinutes,
          expiresAt || undefined
        );

        const emailResult = await sendEmail(emailOptions);
        if (emailResult.success) {
          results.emailsSent++;
        } else {
          results.emailsFailed++;
          results.errors.push(`Failed to send email to ${candidate.email}: ${emailResult.error}`);
        }
      } catch (error: any) {
        results.failed++;
        results.errors.push(`Error processing ${candidate.email}: ${error.message}`);
        logger.error(`Error creating session for ${candidate.email}:`, error);
      }
    }

    res.json({
      success: true,
      data: {
        ...results,
        message: `Created ${results.created} sessions and sent ${results.emailsSent} emails`
      }
    });
  } catch (error: any) {
    logger.error('Bulk session creation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create bulk sessions'
    });
  }
});

export default router;

