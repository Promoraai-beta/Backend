import { Router, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { orchestrateSingleVariant } from '../mcp/servers/serverB';
import { createTemplate } from '../lib/template-utils';
import { buildScenarioContext, activateTools } from '../tools/registry';
import { prisma } from '../lib/prisma';
import { containerManager } from '../services/container-manager';
import { generateSecureSessionCode } from '../lib/session-code';
import { validateSessionCreation, handleValidationErrors } from '../middleware/validation';
import { apiLimiter, sessionCodeLimiter } from '../middleware/rate-limiter';
import { validateSessionCodeSecurity, enforceTimer } from '../middleware/security';
import { checkSessionInactivity } from '../services/inactivity-monitor';
import { scheduleRealtimeIntegrity } from '../services/realtime-integrity';
import { startLiveVideoScan, stopLiveVideoScan } from '../services/live-video-scanner';
import { authenticate, checkSessionOwnership, optionalAuthenticate, requireRole } from '../middleware/rbac';
import * as jwt from 'jsonwebtoken';
import { sendEmail, generateAssessmentEmail } from '../lib/email';
import { getFrontendUrl } from '../lib/frontend-url';
import multer from 'multer';
import { logger } from '../lib/logger';
import { provisionLocalContainer, deleteLocalContainer, getLocalContainerStatus, readContainerFile, writeContainerFile, listContainerFiles, getLocalContainerUrls } from '../services/local-docker-provisioner';
import { provisionAssessmentContainer } from '../services/azure-provisioner';
import { fileServerToken } from '../lib/container-token';
import { readFile } from 'fs/promises';
import { join } from 'path';

/** True when backend/.env sets USE_LOCAL_DOCKER=true. Read lazily so dotenv override takes effect. */
const getUseLocalDocker = () => process.env.USE_LOCAL_DOCKER === 'true';
const USE_LOCAL_DOCKER = getUseLocalDocker(); // cached after first read (dotenv loads before first request)

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

    // ── Fresh template generation per candidate (OpenAI Agents SDK) ──────────
    // Every invite triggers orchestrateSingleVariant — no pre-built templates,
    // no fallbacks. Each candidate gets a unique codebase generated on the spot.
    // For bulk invites the variants are pre-generated and round-robined here.
    let assignedVariantTemplateId: string | null = null;
    let variantMeta: { variantIndex: number; scenarioName: string; fileCount: number; issueCount: number } | null = null;

    if (assessment_id) {
      // Check if bulk variants already exist (bulk-invite flow pre-generates them)
      const existingVariants = await prisma.assessmentVariant.findMany({
        where: { assessmentId: assessment_id },
        orderBy: { variantIndex: 'asc' },
        select: { templateId: true, variantIndex: true }
      });

      if (existingVariants.length > 0) {
        // Bulk path — round-robin across pre-generated variants
        const sessionCount = await prisma.session.count({ where: { assessmentId: assessment_id } });
        const picked = existingVariants[sessionCount % existingVariants.length];
        assignedVariantTemplateId = picked.templateId;
        variantMeta = { variantIndex: picked.variantIndex, scenarioName: '', fileCount: 0, issueCount: 0 };
        logger.info(`[VariantAssign] bulk round-robin → variantIndex=${picked.variantIndex} templateId=${picked.templateId}`);
      } else {
        // Single-invite path — generate a fresh unique template right now
        try {
          const assessment = await prisma.assessment.findUnique({
            where: { id: assessment_id },
            select: {
              role: true, level: true, techStack: true, jobDescription: true,
              companyId: true,
              // Load the recruiter's tasks and numBugs so Server B generates
              // a codebase that matches exactly what was assigned
              template: true,
              templateRef: { select: { suggestedAssessments: true } },
            }
          });

          if (assessment) {
            const techStack = Array.isArray(assessment.techStack) ? assessment.techStack as string[] : [];

            // Resolve recruiter's tasks (suggestedAssessments) for this assessment
            let recruiterTasks: any[] = [];
            if ((assessment as any).templateRef?.suggestedAssessments?.length) {
              recruiterTasks = (assessment as any).templateRef.suggestedAssessments as any[];
            } else if ((assessment as any).template) {
              const tpl = typeof (assessment as any).template === 'string'
                ? JSON.parse((assessment as any).template)
                : (assessment as any).template;
              recruiterTasks = tpl?.suggestedAssessments ?? (Array.isArray(tpl) ? tpl : []);
            }

            // numBugs = number of tasks the recruiter assigned (at least 1, at most 10)
            const numBugs = Math.min(10, Math.max(1, recruiterTasks.length || 3));

            logger.info(`[SingleVariant] Generating fresh template for assessment=${assessment_id} numBugs=${numBugs} tasks=${recruiterTasks.length}`);

            const variant = await orchestrateSingleVariant({
              jobRole:         assessment.role || 'Full Stack Engineer',
              techStack,
              experienceLevel: assessment.level || 'Mid-level',
              complexity:      'medium',
              jobDescription:  (assessment as any).jobDescription || '',
              tasks:           recruiterTasks,
              numBugs,
            });

            // Always create a fresh row for variant templates — never dedup,
            // because each variant must be a structurally distinct codebase.
            // A nonce (timestamp + scenario index) guarantees a unique hash.
            const variantNonce = `${Date.now()}-v${(variant as any).variantIndex ?? 0}`;

            // Convert Server B's intentionalIssues into task objects so the
            // Tasks panel shows the SAME items that are actually broken in the
            // code — not Server A's original descriptions which may differ.
            const issues: Array<{ id: string; description: string; file?: string; severity?: string; category?: string }>
              = (variant as any).intentionalIssues ?? [];
            const derivedTasks = issues.map((issue, idx) => ({
              id:          issue.id ?? `task-${idx + 1}`,
              title:       issue.description.split('.')[0].trim(),   // first sentence as title
              description: issue.description,
              duration:    20,
              difficulty:  issue.severity === 'critical' ? 'hard' : issue.severity === 'high' ? 'medium' : 'easy',
              components:  issue.file ? [issue.file] : [],
              requirements: [issue.description],
              category:    issue.category ?? 'general',
            }));

            // Fall back to recruiter's original tasks only if Server B returned no issues
            const finalTasks = derivedTasks.length > 0 ? derivedTasks : recruiterTasks;

            const template = await createTemplate({
              role:             assessment.role || 'general',
              techStack,
              level:            assessment.level || 'mid',
              templateSpec:     variant,
              suggestedAssessments: finalTasks,
              webcontainerReady: true,
              buildStatus:      'ready',
              variantNonce,
            });

            if (template?.id) {
              assignedVariantTemplateId = template.id;
              variantMeta = {
                variantIndex: (variant as any).variantIndex ?? 0,
                scenarioName: (variant as any).scenarioName ?? '',
                fileCount:    (variant as any).fileCount    ?? 0,
                issueCount:   (variant as any).issueCount   ?? 0,
              };
              logger.info(`[SingleVariant] Template created: ${template.id} scenario="${variantMeta.scenarioName}"`);
            }
          }
        } catch (err: any) {
          logger.error(`[SingleVariant] Template generation failed (session will proceed without template): ${err.message}`);
          // Non-fatal — session is still created, environment provisions later
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // ── Step 1: Provision the container BEFORE creating the session or sending email ──
    // The container MUST be running before the invite goes out.
    // If provisioning fails, we return an error to the recruiter — no session, no email.
    let provisionedContainerId: string | null = null;
    let provisionedContainerUrl: string | null = null;

    if (assignedVariantTemplateId) {
      const MAX_RETRIES = 3;
      const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

      // Load file structure from the just-created template
      const tpl = await prisma.template.findUnique({
        where: { id: assignedVariantTemplateId },
        select: { templateSpec: true },
      });
      const tplSpec = tpl?.templateSpec as any;
      const fileStructure = tplSpec?.fileStructure as Record<string, string> | undefined;

      // ── Sync README.md with actual intentional issues ──────────────────────
      // Server B stores the bugs it injected in templateSpec.intentionalIssues.
      // Override whatever README.md Server B wrote so it always lists the real
      // bugs and matches the Tasks panel exactly.
      if (fileStructure && tplSpec?.intentionalIssues?.length > 0) {
        const issues: Array<{ id: string; description: string; file?: string; severity?: string; category?: string }>
          = tplSpec.intentionalIssues;

        const readmeKey = Object.keys(fileStructure).find(
          k => k === 'README.md' || k.toLowerCase().endsWith('/readme.md')
        ) ?? 'README.md';

        const issueLines = issues.map((issue, i) => {
          const severity = issue.severity ? ` [${issue.severity.toUpperCase()}]` : '';
          const file     = issue.file     ? ` in \`${issue.file}\`` : '';
          return `${i + 1}. **${issue.description}**${severity}${file}`;
        }).join('\n');

        fileStructure[readmeKey] =
`# Assessment Tasks

Fix the following bugs that have been intentionally introduced into this codebase.

## Bugs to Fix

${issueLines}

## Instructions

- Identify each bug in the code
- Fix all ${issues.length} issue${issues.length !== 1 ? 's' : ''} listed above
- Make sure existing functionality still works after your fixes
- You may use the AI Assistant panel for hints (your prompts are evaluated)
`;
        logger.info(`[Provision] README.md synced with ${issues.length} intentional issues`);
      }

      if (fileStructure && Object.keys(fileStructure).length > 0) {
        // Use a temporary ID for provisioning — we'll use the real session ID once created
        // Azure / local Docker only needs a unique string; we'll use sessionCode as the handle
        logger.info(`[Provision] Starting container for session code ${sessionCode} (${Object.keys(fileStructure).length} files)...`);

        let provisionError: string | null = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const result = getUseLocalDocker()
              ? await provisionLocalContainer(sessionCode, fileStructure)
              : await provisionAssessmentContainer(sessionCode, fileStructure);
            const provResult = result as any;
            provisionedContainerId  = provResult.containerId;
            provisionedContainerUrl = provResult.codeServerUrl;
            provisionError = null;
            logger.info(`[Provision] ✅ Container ready (attempt ${attempt}) for ${sessionCode}: ${provisionedContainerUrl}`);
            break;
          } catch (err: any) {
            provisionError = err.message;
            logger.warn(`[Provision] Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
            if (attempt < MAX_RETRIES) {
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
            }
          }
        }

        if (provisionError) {
          // All retries failed — abort. No session created, no email sent.
          logger.error(`[Provision] ❌ All ${MAX_RETRIES} attempts failed for ${sessionCode}: ${provisionError}`);
          return res.status(500).json({
            success: false,
            error: 'Failed to provision the candidate environment. Please try again in a few minutes.',
            detail: provisionError,
          });
        }
      } else {
        logger.info(`[Provision] Template has no fileStructure — no container needed for ${sessionCode}`);
      }
    }

    // ── Step 2: Create the session row — container is confirmed running ────────
    const data = await prisma.session.create({
      data: {
        sessionCode,
        candidateId:   finalCandidateId   || null,
        candidateName: finalCandidateName  || null,
        candidateEmail: finalCandidateEmail || null,
        recruiterEmail: recruiter_email    || null,
        assessmentId:  assessment_id       || null,
        timeLimit:     time_limit          || 3600,
        expiresAt:     expires_at ? new Date(expires_at) : null,
        status:        status              || 'pending',
        assignedVariantId: assignedVariantTemplateId || null,
        // Container already running — store the URL so /start can use it immediately
        ...(provisionedContainerId  && { containerId:     provisionedContainerId  }),
        ...(provisionedContainerUrl && { containerUrl:    provisionedContainerUrl }),
        ...(assignedVariantTemplateId && {
          containerStatus: provisionedContainerUrl ? 'ready' : 'pending',
        }),
      } as any,
      include: {
        assessment: {
          include: { company: true }
        }
      }
    });

    const frontendUrl = getFrontendUrl();
    const assessmentUrl = `${frontendUrl}/assessment/${sessionCode}`;

    // ── Step 3: Send the invite email — container is running, URL is saved ────
    let emailDelivered = false;
    if (userRole === 'recruiter' && assessment_id && finalCandidateEmail) {
      try {
        const recruiterProfile = await prisma.recruiterProfile.findUnique({
          where: { userId: userId || '' },
          include: { company: true, user: true }
        });

        if (recruiterProfile && data.assessment) {
          const companyName      = data.assessment.company?.name || recruiterProfile.company?.name || 'Our Company';
          const recruiterName    = recruiterProfile.user?.name || 'Recruiter';
          const jobTitle         = data.assessment.jobTitle || data.assessment.role || undefined;
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

          const emailResult = await sendEmail(emailOptions);
          emailDelivered = !!(emailResult.success && emailResult.delivered);
          if (!emailResult.success) {
            logger.warn('Invitation email failed:', emailResult.error);
          }
        }
      } catch (emailError) {
        logger.error('Error sending invitation email:', emailError);
        // Email failure is non-fatal — session and container are already live
      }
    }

    res.json({
      success: true,
      data: {
        ...data,
        emailDelivered,
        assessmentUrl,
        assignedVariantTemplateId,
        variantMeta,
      }
    });
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
        const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-key-change-in-production';
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
        },
        agentInsights: true,
        aiInteractions: {
          orderBy: { timestamp: 'asc' }
        },
        codeSnapshots: {
          orderBy: { timestamp: 'asc' }
        },
        events: {
          orderBy: { timestamp: 'asc' }
        },
        submissions: {
          orderBy: { submittedAt: 'asc' }
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

// POST /sessions/:id/mcp-insights — receive plugin insights (e.g. Figma) from MCP client
router.post('/:id/mcp-insights', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const sessionId = req.params.id;
    const { source, payload } = req.body || {};
    if (!source || payload === undefined) {
      return res.status(400).json({ success: false, error: 'Missing source or payload' });
    }
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true } });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    await prisma.mcpInsight.create({ data: { sessionId, source, payload: payload as object } });
    logger.log(`[MCP] Insight from ${source} for session ${sessionId}`);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /sessions/:id/mcp-insights — list design/plugin activity for session (e.g. Figma actions)
router.get('/:id/mcp-insights', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const sessionId = req.params.id;
    const source = req.query.source as string | undefined;
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true } });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    const where = { sessionId } as { sessionId: string; source?: string };
    if (source) where.source = source;
    const insights = await prisma.mcpInsight.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json({ success: true, data: insights });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /sessions/:id/provision-figma — link Figma design space for this session (space to work on design task)
router.post('/:id/provision-figma', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const sessionId = req.params.id;
    const { figmaTemplateId, figmaFileKey, figmaAccessToken } = req.body || {};
    const token = figmaAccessToken || process.env.FIGMA_ACCESS_TOKEN;
    const templateId = figmaFileKey || figmaTemplateId || process.env.FIGMA_TEMPLATE_FILE_ID || process.env.FIGMA_RESOURCE_ID;
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'FIGMA_ACCESS_TOKEN is not set in the backend .env. Add it and restart the backend.',
        code: 'MISSING_TOKEN'
      });
    }
    if (!templateId) {
      return res.status(400).json({
        success: false,
        error: 'No Figma file key. Set FIGMA_TEMPLATE_FILE_ID in backend .env (e.g. your file key from the Figma URL) or add figmaFileKey to the assessment.',
        code: 'MISSING_FILE_KEY'
      });
    }
    let session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true, figmaFileUrl: true, figmaResourceId: true } });
    // Test page uses a sandbox session that may not exist yet; create it so provision works
    const TEST_SANDBOX_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    if (!session && sessionId === TEST_SANDBOX_ID) {
      session = await prisma.session.upsert({
        where: { id: TEST_SANDBOX_ID },
        create: { id: TEST_SANDBOX_ID, sessionCode: 'TESTSANDBOX-AZURE-FIGMA', status: 'active', timeLimit: 3600 },
        update: {},
        select: { id: true, figmaFileUrl: true, figmaResourceId: true },
      });
    }
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (session.figmaFileUrl && session.figmaResourceId) {
      return res.json({
        success: true,
        url: session.figmaFileUrl,
        resourceId: session.figmaResourceId,
        reused: true
      });
    }
    const { getPlugin } = await import('../services/plugin-registry');
    const figma = getPlugin('figma');
    if (!figma) return res.status(503).json({ success: false, error: 'Figma plugin not available' });
    const result = await figma.provision(sessionId, {
      templateId,
      figmaTemplateId: templateId,
      credentials: { FIGMA_ACCESS_TOKEN: token }
    });
    await prisma.session.update({
      where: { id: sessionId },
      data: { figmaFileUrl: result.url, figmaResourceId: result.resourceId }
    });
    logger.log(`[Figma] Provisioned for session ${sessionId}: ${result.url}`);
    res.json({ success: true, url: result.url, resourceId: result.resourceId });
  } catch (error: any) {
    logger.error('[Figma] Provision failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /sessions/:id/provision-sheets — create a fresh Google Sheet for the candidate (no template needed)
router.post('/:id/provision-sheets', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const sessionId = req.params.id;
    const { taskTitle, taskDescription } = req.body || {};

    const session = await (prisma.session.findUnique as any)({
      where: { id: sessionId },
      select: { id: true, toolResources: true, sheetsFileUrl: true, sheetsResourceId: true }
    });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    // Reuse existing sheet if already provisioned
    const { getTool } = await import('../services/tool-resources');
    const existingSheets = getTool(session, 'sheets');
    if (existingSheets) {
      return res.json({ success: true, url: existingSheets.url, viewUrl: existingSheets.viewUrl, resourceId: existingSheets.resourceId, reused: true });
    }

    const sheetTitle = taskTitle || `Assessment Spreadsheet`;

    const { getOAuthAccessToken } = await import('../services/google-auth');
    const accessToken = await getOAuthAccessToken();

    

    // Create a brand-new Google Sheet via Sheets API v4
    const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        properties: { title: sheetTitle },
        sheets: [{ properties: { title: 'Sheet1' } }],
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return res.status(502).json({ success: false, error: `Google Sheets API error: ${errText.slice(0, 300)}` });
    }

    const sheet = await createRes.json() as any;
    const sheetId = sheet.spreadsheetId;
    const sheetUrl = sheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

    // Move into the shared parent folder if configured (avoids service-account 0-quota limit)
    const parentFolderId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
    if (parentFolderId) {
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${sheetId}?addParents=${parentFolderId}&removeParents=root&fields=id`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}` } },
      );
    }

    // Set "anyone with link can edit" permission
    await fetch(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ role: 'writer', type: 'anyone' }),
    });

    // Pre-fill sheet with task context so candidate knows what to build
    const prefillRows: string[][] = [
      ['📋 Task', taskTitle || 'Spreadsheet Challenge'],
      ['📝 Description', taskDescription || ''],
      ['', ''],
      ['Instructions', 'Use this spreadsheet to complete your task. Add data, formulas, and sheets as needed.'],
      ['', ''],
    ];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=RAW`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ values: prefillRows }),
    });

    // Bold the header rows (A1:B2) for clarity
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: [{
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold'
          }
        }]
      }),
    });

    const sheetsViewUrl = sheetUrl.replace(/\/edit.*$/, '/view');
    const { upsertToolResource } = await import('../services/tool-resources');
    await upsertToolResource(prisma, sessionId, 'sheets', {
      url: sheetUrl,
      viewUrl: sheetsViewUrl,
      resourceId: sheetId,
      provisionedAt: new Date().toISOString(),
    });

    logger.log(`[Sheets] Created Google Sheet for session ${sessionId}: ${sheetUrl}`);
    res.json({ success: true, url: sheetUrl, viewUrl: sheetsViewUrl, resourceId: sheetId });
  } catch (error: any) {
    logger.error('[Sheets] Provision failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /sessions/:id/provision-docs — create a fresh Google Doc for the candidate (no template needed)
router.post('/:id/provision-docs', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const sessionId = req.params.id;
    const { taskTitle, taskDescription } = req.body || {};

    const session = await (prisma.session.findUnique as any)({
      where: { id: sessionId },
      select: { id: true, toolResources: true }
    });

    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    // Reuse existing doc if already provisioned (and it was pre-filled)
    const { getTool } = await import('../services/tool-resources');
    const existingDocs = getTool(session, 'docs');
    if (existingDocs) {
      return res.json({ success: true, url: existingDocs.url, viewUrl: existingDocs.viewUrl, resourceId: existingDocs.resourceId, reused: true });
    }

    // Requires a Google Service Account JSON key in GOOGLE_SERVICE_ACCOUNT_JSON env var
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
      return res.status(503).json({
        success: false,
        error: 'Google Docs not configured. Add GOOGLE_SERVICE_ACCOUNT_JSON to backend .env (see setup guide).',
        code: 'MISSING_GOOGLE_CONFIG'
      });
    }

    const docTitle = taskTitle || `Assessment Documentation`;

    // Get OAuth token for real Google account (service account has 0 Drive quota)
    const { getOAuthAccessToken } = await import('../services/google-auth');
    const accessToken = await getOAuthAccessToken();

    // Create a brand new Google Doc via Drive API (mimeType = google-apps.document).
    // Pass GOOGLE_DRIVE_PARENT_FOLDER_ID so the file lands in the shared folder
    // (avoids service-account 0-quota limit — storage counts against folder owner).
    const parentFolderId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
    const docBody: Record<string, any> = {
      name: docTitle,
      mimeType: 'application/vnd.google-apps.document',
    };
    if (parentFolderId) docBody.parents = [parentFolderId];

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(docBody),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return res.status(502).json({ success: false, error: `Google Drive API error (create doc): ${errText.slice(0, 300)}` });
    }

    const doc = await createRes.json() as any;
    const docId = doc.id;
    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;

    // Set doc to "anyone with link can edit" so the candidate can access without sign-in
    await fetch(`https://www.googleapis.com/drive/v3/files/${docId}/permissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ role: 'writer', type: 'anyone' }),
    });

    // Pre-fill with task description if provided (uses Docs API)
    let prefillOk = false;
    let prefillError = '';
    if (taskDescription) {
      try {
        const { getOAuthAccessToken: getOAuth } = await import('../services/google-auth');
        const docsToken = await getOAuth();
        const prefillRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${docsToken}`,
          },
          body: JSON.stringify({
            requests: [
              {
                insertText: {
                  location: { index: 1 },
                  text: `Task: ${taskTitle || 'Documentation Task'}\n\n${taskDescription}\n\n---\n\nYour answer:\n\n`,
                }
              }
            ]
          }),
        });
        if (prefillRes.ok) {
          prefillOk = true;
          logger.log(`[Docs] Pre-filled doc ${docId} successfully`);
        } else {
          prefillError = await prefillRes.text();
          logger.warn(`[Docs] Pre-fill failed (${prefillRes.status}): ${prefillError.slice(0, 200)}`);
        }
      } catch (prefillErr: any) {
        prefillError = prefillErr.message;
        logger.warn(`[Docs] Pre-fill exception: ${prefillErr.message}`);
      }
    }

    const docsViewUrl = docUrl.replace(/\/edit.*$/, '/preview');
    const { upsertToolResource } = await import('../services/tool-resources');
    await upsertToolResource(prisma, sessionId, 'docs', {
      url: docUrl,
      viewUrl: docsViewUrl,
      resourceId: docId,
      provisionedAt: new Date().toISOString(),
    });

    logger.log(`[Docs] Created Google Doc for session ${sessionId}: ${docUrl} (prefill: ${prefillOk})`);
    res.json({ success: true, url: docUrl, viewUrl: docsViewUrl, resourceId: docId, prefillOk, prefillError: prefillOk ? undefined : prefillError });
  } catch (error: any) {
    logger.error('[Docs] Provision failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /sessions/:id/db/ping — probe pgweb inside the candidate container (used by DatabaseTabView to know when ready)
// Self-healing: if pgweb is not running, auto-starts it via the file-server exec API.
router.get('/:id/db/ping', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const sessionId = req.params.id;
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { containerUrl: true } as any,
    }) as any;

    if (!session?.containerUrl) {
      return res.status(404).json({ ready: false, error: 'No container URL for this session' });
    }

    // Derive pgweb URL from code-server URL — same host, port 5050
    const pgwebUrl = (session.containerUrl as string).replace(/:(\d+)\/?$/, ':5050');
    const fileServerBase = (session.containerUrl as string).replace(/:(\d+)\/?$/, ':9090');
    const token = fileServerToken(sessionId);

    const tryPing = async (): Promise<boolean> => {
      try {
        const pgRes = await fetch(pgwebUrl, { method: 'GET', signal: AbortSignal.timeout(4000) });
        return pgRes.status >= 200 && pgRes.status < 300;
      } catch { return false; }
    };

    // Fast path — pgweb already running
    if (await tryPing()) {
      return res.json({ ready: true, url: pgwebUrl });
    }

    // pgweb not reachable — check if process is alive and auto-start if needed
    try {
      const psRes = await fetch(`${fileServerBase}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ command: 'ps aux | grep -c "[p]gweb" || echo 0', timeout: 3000 }),
        signal: AbortSignal.timeout(5000),
      });
      if (psRes.ok) {
        const psData = await psRes.json() as any;
        const count = parseInt((psData.stdout || '0').trim(), 10);
        if (count === 0) {
          // pgweb not running at all — start it with correct flags
          logger.log(`[DB Ping] pgweb not running for session ${sessionId} — auto-starting`);
          await fetch(`${fileServerBase}/exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              command: 'pgweb --url="postgres://postgres:postgres@localhost:5432/assessmentdb?sslmode=disable" --bind=0.0.0.0 --listen=5050 --readonly 2>/tmp/pgweb.log &',
              timeout: 3000,
            }),
            signal: AbortSignal.timeout(5000),
          });
          // Give pgweb 2 s to bind
          await new Promise(r => setTimeout(r, 2000));
          if (await tryPing()) {
            logger.log(`[DB Ping] pgweb auto-started successfully for session ${sessionId}`);
            return res.json({ ready: true, url: pgwebUrl, autoStarted: true });
          }
        }
        // else: process is running but not yet serving (still starting) — caller should retry
      }
    } catch (execErr: any) {
      logger.warn(`[DB Ping] exec auto-start failed: ${execErr.message}`);
    }

    return res.status(503).json({ ready: false });
  } catch (error: any) {
    logger.error('[DB Ping]', error.message);
    res.status(500).json({ ready: false, error: error.message });
  }
});

// GET /sessions/:id/db/diagnostics — read pgweb log + check if process is running
router.get('/:id/db/diagnostics', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const sessionId = req.params.id;
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { containerUrl: true } as any,
    }) as any;

    if (!session?.containerUrl) {
      return res.status(404).json({ error: 'No container URL' });
    }

    const fileServerBase = (session.containerUrl as string).replace(/:(\d+)\/?$/, ':9090');
    const token = fileServerToken(sessionId);

    const execCmd = async (command: string) => {
      try {
        const r = await fetch(`${fileServerBase}/exec`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ command, timeout: 5000 }),
          signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) return `exec failed: ${r.status}`;
        const data = await r.json() as any;
        return (data.stdout || '') + (data.stderr ? '\nSTDERR: ' + data.stderr : '');
      } catch (e: any) { return `fetch error: ${e.message}`; }
    };

    const [psOut, pgwebLog, pgwebPing] = await Promise.all([
      execCmd('ps aux | grep pgweb | grep -v grep'),
      execCmd('cat /tmp/pgweb.log 2>/dev/null || echo "(no log file)"'),
      execCmd('curl -s -o /dev/null -w "%{http_code}" http://localhost:5050 --max-time 3 || echo "curl failed"'),
    ]);

    res.json({ pgwebProcess: psOut, pgwebLog, pgwebLocalPing: pgwebPing });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /sessions/:id/refresh-sheets-insight — run Sheets plugin analyze and save as MCP insight (for testing full loop)
router.post('/:id/refresh-sheets-insight', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const sessionId = req.params.id;
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, sheetsResourceId: true }
    });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (!session.sheetsResourceId) {
      return res.status(400).json({
        success: false,
        error: 'Session has no Google Sheet. Provision a sheet first (Sheets tab → Open Google Sheet).',
        code: 'NO_SHEETS_RESOURCE'
      });
    }
    const { getPlugin } = await import('../services/plugin-registry');
    const sheets = getPlugin('sheets');
    if (!sheets) return res.status(503).json({ success: false, error: 'Google Sheets plugin not available' });
    const result = await sheets.analyze(session.sheetsResourceId, {});
    const payload = result?.insights ?? {};
    await prisma.mcpInsight.create({
      data: { sessionId, source: 'sheets', payload: payload as object }
    });
    logger.log(`[Sheets] Insight saved for session ${sessionId}`);
    res.json({ success: true, payload });
  } catch (error: any) {
    logger.error('[Sheets] Refresh insight failed:', error.message);
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
        assignedVariant: true, // variant-assigned template (null → fall back to assessment.templateRef)
        assessment: {
          include: {
            company: true,
            templateRef: true  // Include reusable template so tasks/files are available before /start
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
        // Template is stored as JSON on assessment.template (inline) or on assessment.templateRef (reusable)
        let template = data.assessment.template;
        if (typeof template === 'string') {
          try { template = JSON.parse(template); } catch (e) {
            logger.error('Failed to parse assessment template:', e);
            template = null;
          }
        }

        // Fall back to reusable templateRef when inline template is absent.
        // Prefer assignedVariant (round-robin variant pool) over assessment.templateRef when set.
        const assignedVariantTemplate = (data as any).assignedVariant ?? null;
        const templateRef = assignedVariantTemplate ?? (data.assessment as any).templateRef ?? null;
        if (assignedVariantTemplate) {
          logger.log(`🎯 [code/:code] Using variant template: ${assignedVariantTemplate.templateHash?.substring(0, 8)}...`);
        }

        // Extract suggestedAssessments: prefer inline template, fall back to templateRef
        let suggestedAssessments: any[] = [];
        if (template && typeof template === 'object') {
          if ('suggestedAssessments' in template) {
            suggestedAssessments = (template as any).suggestedAssessments || [];
          } else if (Array.isArray(template)) {
            suggestedAssessments = template;
          }
        }
        if (suggestedAssessments.length === 0 && templateRef?.suggestedAssessments) {
          suggestedAssessments = templateRef.suggestedAssessments as any[];
          logger.log(`📋 Loaded ${suggestedAssessments.length} tasks from templateRef`);
        }
        
        response.assessmentTemplate = suggestedAssessments;
        response.assessmentMeta = {
          role: data.assessment.role,
          level: data.assessment.level,
          techStack: Array.isArray(data.assessment.techStack) ? data.assessment.techStack : [],
          jobTitle: data.assessment.jobTitle,
          company: (data.assessment as any).company?.name || null
        };

        // Design (Figma): check inline template then templateRef
        const figmaKey = (template && typeof template === 'object'
          ? ((template as any).figmaFileKey ?? (template as any).figmaTemplateId)
          : null)
          ?? (templateRef && typeof templateRef.templateSpec === 'object'
            ? (templateRef.templateSpec as any)?.figmaFileKey
            : null);
        if (figmaKey) {
          response.assessmentMeta.hasDesign = true;
          response.assessmentMeta.figmaFileKey = figmaKey;
          response.assessmentMeta.figmaTemplateId = figmaKey;
        }
        response.figmaFileUrl = data.figmaFileUrl ?? null;
        response.figmaResourceId = data.figmaResourceId ?? null;

        // Google Sheets: check inline template then templateRef
        const sheetsKey = (template && typeof template === 'object'
          ? ((template as any).sheetsTemplateId ?? (template as any).sheetsFileKey)
          : null)
          ?? (templateRef && typeof templateRef.templateSpec === 'object'
            ? (templateRef.templateSpec as any)?.sheetsTemplateId
            : null);
        if (sheetsKey) {
          response.assessmentMeta.hasSheets = true;
          response.assessmentMeta.sheetsTemplateId = sheetsKey;
        }
        // Tool resources from JSON column (back-compat: also check legacy columns)
        const { getToolResources } = await import('../services/tool-resources');
        response.toolResources = getToolResources(data);
        // Keep legacy fields for backward compat with older frontend code
        response.sheetsFileUrl = response.toolResources?.sheets?.url ?? data.sheetsFileUrl ?? null;

        // ── Tool registry: activate all tools for this scenario ──────────────
        const templateComponents: string[] = (
          (template && typeof template === 'object' && Array.isArray((template as any).components))
            ? ((template as any).components as string[])
            : (templateRef && typeof templateRef.templateSpec === 'object' && Array.isArray((templateRef.templateSpec as any)?.components))
              ? ((templateRef.templateSpec as any).components as string[])
              : []
        );

        const codePageFileStructure: Record<string, string> =
          (template && typeof template === 'object' && (template as any)?.templateSpec?.fileStructure)
            ? (template as any).templateSpec.fileStructure
            : (templateRef && typeof templateRef.templateSpec === 'object'
                ? (templateRef.templateSpec as any)?.fileStructure ?? {}
                : {});

        const codePageIssues: any[] =
          (templateRef && typeof templateRef.templateSpec === 'object'
            ? (templateRef.templateSpec as any)?.intentionalIssues
            : null)
          ?? (template && typeof template === 'object'
            ? (template as any)?.intentionalIssues
            : null)
          ?? [];

        const codePageCtx = buildScenarioContext({
          fileStructure:     codePageFileStructure,
          intentionalIssues: codePageIssues,
          jobRole:           data.assessment.role ?? '',
          techStack:         Array.isArray(data.assessment.techStack) ? data.assessment.techStack as string[] : [],
          jobDescription:    (data.assessment as any).jobDescription ?? '',
          companyName:       (data.assessment as any).company?.name ?? '',
          level:             data.assessment.level ?? 'Mid-level',
          recruiterTasks:    suggestedAssessments,
          derivedTasks:      suggestedAssessments,
          components:        templateComponents,
        });



        // Early pre-provision: fire docs tool in background on page load
        // so the Google Doc is ready before the candidate clicks Start.
        // /start will call activateTools again — docs.tool.ts is idempotent (skips if URL exists).
        const existingDocUrlEarly = response.toolResources?.docs?.url ?? null;
        await activateTools(data.id, data.sessionCode, codePageCtx, response, {
          fireAndForget: !existingDocUrlEarly,
        });

        response.docsFileUrl = response.toolResources?.docs?.url ?? response.docsFileUrl ?? (data as any).docsFileUrl ?? null;

        // Extract template files: prefer inline templateSpec, fall back to templateRef.templateSpec
        const effectiveTemplateSpec = (template && typeof template === 'object' && 'templateSpec' in template)
          ? (template as any).templateSpec
          : (templateRef?.templateSpec ?? null);

        if (effectiveTemplateSpec?.fileStructure) {
          response.templateFiles = effectiveTemplateSpec.fileStructure;
          logger.log(`📁 Including template files from ${templateRef && !((template as any)?.templateSpec) ? 'templateRef' : 'inline template'} (${Object.keys(effectiveTemplateSpec.fileStructure).length} files)`);
        } else if (template && typeof template === 'object' && 'files' in template) {
          response.templateFiles = (template as any).files;
          logger.log('📁 Including template files in session response (files key)');
        }
        
        logger.log('📋 Session API: Sending assessment template:', {
          hasTemplate: !!template,
          suggestedAssessmentsCount: suggestedAssessments.length,
          templateType: typeof template,
          meta: response.assessmentMeta
        });
      }

    // Always include container info so the frontend can:
    // - Show a "Preparing your environment..." spinner when containerStatus === 'provisioning'
    // - Enable the Start button only when containerStatus === 'ready'
    // - Show an error state when containerStatus === 'failed'
    response.containerUrl    = data.containerUrl    ?? null;
    response.containerStatus = (data as any).containerStatus ?? 'pending';

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
    // Also include assignedVariant so we can use the variant-specific template when set
    const session = await prisma.session.findUnique({
      where: { id },
      include: {
        assignedVariant: true, // variant-assigned template (null → fall back to assessment.templateRef)
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

    // Guard: refuse to start a session that is already completed or expired.
    // This prevents replay attacks where someone re-sends a /start request after the
    // assessment has ended to reset the session state.
    if (session.status === 'completed' || session.status === 'expired') {
      return res.status(409).json({ success: false, error: `Session is already ${session.status}` });
    }

    // If a session_code header or body field is provided, verify it matches the session.
    // The frontend currently does not send it, so we only reject when it is present but wrong.
    const providedCode = (req.headers['x-session-code'] as string) || req.body?.session_code;
    if (providedCode && providedCode !== session.sessionCode) {
      return res.status(403).json({ success: false, error: 'Session code mismatch' });
    }

    // Update session status and re-fetch with assessment to ensure assessmentType is included
    const data = await prisma.session.update({
      where: { id },
      data: {
        status: 'active',
        startedAt: new Date()
      },
      include: {
        assignedVariant: true, // variant-assigned template (null → fall back to assessment.templateRef)
        assessment: {
          include: {
            company: true,
            templateRef: true // Include reusable template if available
          }
        }
      }
    });

    // Start live video scanner for this session (fires every 5 min, suspicion-gated)
    startLiveVideoScan(id);

    // Extract template files IMMEDIATELY from assessment data (don't wait for containers)
    // Template files are already stored in the assessment, so we can return them right away
    let templateFiles: Record<string, string> | null = null;
    let containerInfo: any = null;
    let needsContainer = false; // Only true for IDE challenges
    let template: any = null; // Declare template in outer scope
    
    if (data.assessment) {
      // PRIORITY 1: Use variant-assigned template when present (anti-cheating round-robin variant pool)
      // PRIORITY 2: Fall back to assessment.templateRef (single-template mode)
      // PRIORITY 3: Fall back to inline template storage (legacy)
      let templateSpec = null;
      let suggestedAssessments = null;

      // Resolve the effective templateRef: prefer assignedVariant over assessment.templateRef
      const assignedVariant = (data as any).assignedVariant ?? null;
      const effectiveTemplateRef = assignedVariant ?? data.assessment.templateRef ?? null;
      if (assignedVariant) {
        logger.log(`🎯 Using variant template: ${assignedVariant.templateHash?.substring(0, 8)}... (variantId: ${data.assignedVariantId})`);
      }

      // Check if assessment has a template reference (new reusable template system)
      if (effectiveTemplateRef) {
        const templateRef = effectiveTemplateRef;
        templateSpec = templateRef.templateSpec as any;
        const refSuggestedAssessments = templateRef.suggestedAssessments;
        suggestedAssessments = Array.isArray(refSuggestedAssessments) ? refSuggestedAssessments : null;
        if (!assignedVariant) {
          logger.log(`📦 Using reusable template: ${templateRef.templateHash?.substring(0, 8)}... (usage: ${templateRef.usageCount})`);
        }
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
        logger.log(`📁 Extracted ${templateFiles ? Object.keys(templateFiles).length : 0} template files from ${data.assessment.templateRef ? 'reusable template' : 'inline template'} (fileStructure)`);
      } else if (template && typeof template === 'object' && 'files' in template && typeof (template as any).files === 'object') {
        // Handle templates stored in { files: { "path": "content" } } format
        templateFiles = (template as any).files as Record<string, string>;
        logger.log(`📁 Extracted ${Object.keys(templateFiles).length} template files from inline template (files key)`);
      }
      
      if (templateFiles && Object.keys(templateFiles).length > 0) {
        needsContainer = true;
      } else {
        logger.log('ℹ️ No template files found in assessment (code challenge or template files not stored)');
      }

      // Only provision container for IDE challenges (which have templateFiles)
      // Code challenges don't need containers, so skip provisioning for them
      if (needsContainer && templateFiles) {
        // ── Container was guaranteed-provisioned at invite time ───────────────
        // By design, the invite is only sent AFTER the container is confirmed running.
        // containerStatus === 'ready' is the expected state when a candidate hits /start.
        const preProvStatus       = (data as any).containerStatus as string | null;
        const existingContainerUrl = (data as any).containerUrl   as string | null;

        if (existingContainerUrl) {
          // ✅ Container was provisioned at invite time — always the expected path
          logger.log(`🔥 Container ready for session ${id}: ${existingContainerUrl}`);
          containerInfo = {
            status: 'ready',
            url: existingContainerUrl,
            message: 'Container ready.',
          };
        } else {
          // Should not happen — the daily health monitor re-provisions any failed containers.
          // Log it for ops visibility but don't surface it to the candidate.
          logger.error(`[Session Start] No container URL for session ${id} (status=${preProvStatus}) — health monitor should have caught this`);
          containerInfo = {
            status: 'ready',
            url: null,
            message: 'Container info unavailable.',
          };
        }
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
      // Resolve meta from templateRef first (reusable templates), then fall back to inline template.
      const refData = data.assessment.templateRef as any;
      const figmaKey = refData?.figmaFileKey ?? refData?.figmaTemplateId
        ?? (template && typeof template === 'object'
          ? ((template as any).figmaFileKey ?? (template as any).figmaTemplateId)
          : null);
      if (figmaKey) {
        response.assessmentMeta.hasDesign = true;
        response.assessmentMeta.figmaFileKey = figmaKey;
        response.assessmentMeta.figmaTemplateId = figmaKey;
      }
      response.figmaFileUrl = data.figmaFileUrl ?? null;
      response.figmaResourceId = data.figmaResourceId ?? null;
      const sheetsKey = refData?.sheetsTemplateId ?? refData?.sheetsFileKey
        ?? (template && typeof template === 'object'
          ? ((template as any).sheetsTemplateId ?? (template as any).sheetsFileKey)
          : null);
      if (sheetsKey) {
        response.assessmentMeta.hasSheets = true;
        response.assessmentMeta.sheetsTemplateId = sheetsKey;
      }
      const { getToolResources: getToolResources2 } = await import('../services/tool-resources');
      response.toolResources = getToolResources2(data);
      response.sheetsFileUrl = response.toolResources?.sheets?.url ?? data.sheetsFileUrl ?? null;

      // ── Tool registry: activate all tools for this scenario ──────────────
      // Each tool detects itself, derives content from the scenario context,
      // and enriches the response — no hardcoded per-tool conditionals needed.
      const templateComponents2: string[] = (
        (template && typeof template === 'object' && Array.isArray((template as any).components))
          ? ((template as any).components as string[])
          : (refData && Array.isArray((refData as any)?.components))
            ? ((refData as any).components as string[])
            : []
      );

      // Resolve the fileStructure for this session's template
      const sessionFileStructure: Record<string, string> =
        templateFiles ??
        refData?.templateSpec?.fileStructure ??
        (template && typeof template === 'object' ? (template as any)?.templateSpec?.fileStructure : null) ??
        {};

      // Resolve intentionalIssues from the session's variant template
      const sessionIssues: any[] =
        (refData?.templateSpec as any)?.intentionalIssues ??
        (template && typeof template === 'object' ? (template as any)?.intentionalIssues : null) ??
        [];

      const scenarioCtx = buildScenarioContext({
        fileStructure:     sessionFileStructure,
        intentionalIssues: sessionIssues,
        jobRole:           data.assessment.role ?? '',
        techStack:         Array.isArray(data.assessment.techStack) ? data.assessment.techStack as string[] : [],
        jobDescription:    (data.assessment as any).jobDescription ?? '',
        companyName:       data.assessment.company?.name ?? '',
        level:             data.assessment.level ?? 'Mid-level',
        recruiterTasks:    suggestedAssessments,
        derivedTasks:      suggestedAssessments,
        components:        templateComponents2,
      });



      // Skip docs auto-provision if doc URL already exists from a previous start
      const existingDocUrl = response.toolResources?.docs?.url ?? null;
      const fireAndForgetDocs = !existingDocUrl;

      await activateTools(id, data.sessionCode, scenarioCtx, response, {
        fireAndForget: fireAndForgetDocs,
      });

      response.docsFileUrl = response.toolResources?.docs?.url ?? response.docsFileUrl ?? (data as any).docsFileUrl ?? null;

      // Include templateFiles from templateRef if available and not already populated
      if (!templateFiles && refData?.templateSpec?.fileStructure) {
        response.templateFiles = refData.templateSpec.fileStructure;
      } else if (!templateFiles && refData?.files && typeof refData.files === 'object') {
        response.templateFiles = refData.files;
      }
      // Fall back to inline template's file structure
      if (!response.templateFiles && template && typeof template === 'object') {
        if ('templateSpec' in template) {
          const templateSpec = (template as any).templateSpec;
          if (templateSpec && templateSpec.fileStructure) {
            response.templateFiles = templateSpec.fileStructure;
          }
        } else if ('files' in template && typeof (template as any).files === 'object') {
          response.templateFiles = (template as any).files;
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
    
    // Check if tab switch limit exceeded — auto-end session
    if (newTabSwitchCount >= MAX_TAB_SWITCHES) {
      await prisma.session.update({
        where: { id },
        data: {
          status: 'ended',
          submittedAt: new Date(),
          tabSwitchCount: newTabSwitchCount,
          lastTabSwitchAt: new Date()
        }
      });

      stopLiveVideoScan(id);
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

    // Tab switch is a suspicion signal — immediately re-run watcher
    scheduleRealtimeIntegrity(id);

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
    const { finalCode } = req.body || {};

    // Check current session status - don't update if already ended
    const current = await prisma.session.findUnique({
      where: { id }
    });

    if (!current) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Only update if session is still active or pending
    if (current.status === 'active' || current.status === 'pending') {
      const updateData: any = {
        status: 'submitted',
        submittedAt: new Date(),
      };

      // Save final IDE files if provided (JSON string of {path: content})
      if (finalCode && typeof finalCode === 'string') {
        updateData.finalCode = finalCode.substring(0, 5_000_000); // 5MB cap
      }

      const data = await prisma.session.update({
        where: { id },
        data: updateData,
      });

      res.json({ success: true, data });

      // Stop the live video scanner for this session immediately
      stopLiveVideoScan(id);

      // After responding — run cleanup tasks asynchronously so the HTTP response
      // is already delivered to the candidate before any slow network calls.
      setImmediate(async () => {
        // ── 1. Collect workspace files from the container file-server (port 9090) ──
        // For Azure Container (code-server) sessions the frontend can't read files
        // directly (the IDE lives in an iframe). The container exposes a lightweight
        // file API on port 9090 that we can call server-side.
        if (current.containerUrl && !updateData.finalCode) {
          try {
            const fileServerBase = current.containerUrl.replace(/:(\d+)\/?$/, ':9090');
            // Step 1: list all files
            const listRes = await fetch(`${fileServerBase}/files`, { signal: AbortSignal.timeout(10_000) });
            if (listRes.ok) {
              const { files } = await listRes.json() as { files: string[] };
              const skipExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.map']);
              const filesToRead = (files || []).filter((f: string) => {
                const ext = f.slice(f.lastIndexOf('.')).toLowerCase();
                return !skipExts.has(ext);
              });

              // Step 2: read each file (parallel, with concurrency cap)
              const allFiles: Record<string, string> = {};
              const CONCURRENCY = 10;
              for (let i = 0; i < filesToRead.length; i += CONCURRENCY) {
                const batch = filesToRead.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (relPath: string) => {
                  try {
                    const r = await fetch(`${fileServerBase}/files/${encodeURIComponent(relPath)}`, { signal: AbortSignal.timeout(5_000) });
                    if (r.ok) {
                      const body = await r.json() as { content: string };
                      allFiles[relPath] = body.content ?? '';
                    }
                  } catch { /* skip unreadable files */ }
                }));
              }

              if (Object.keys(allFiles).length > 0) {
                const serialized = JSON.stringify(allFiles).substring(0, 5_000_000);
                await prisma.session.update({ where: { id }, data: { finalCode: serialized } });
                // Also snapshot for history
                await prisma.codeSnapshot.create({
                  data: { sessionId: id, code: serialized, language: 'json', lineCount: Object.keys(allFiles).length },
                });
                logger.log(`[Session End] Collected ${Object.keys(allFiles).length} files from container for session ${id}`);
              }
            }
          } catch (e: any) {
            logger.warn('[Session End] Could not collect files from container:', e.message);
          }
        }

        // ── 1b. Collect terminal exec history from container file-server ──────
        // The container's file-server.js keeps a rolling log of the last 20
        // commands (command, cwd, exitCode, stdout, stderr, startedAt, finishedAt).
        // We persist each entry as a command_executed Event so terminal_analyzer.py
        // and timeBehaviorAgent.ts see real terminal evidence, not just inferred events.
        if (current.containerUrl) {
          try {
            const fileServerBase = current.containerUrl.replace(/:(\d+)\/?$/, ':9090');
            const token = fileServerToken(id);
            const histRes = await fetch(`${fileServerBase}/exec/history?n=20`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(8_000),
            });
            if (histRes.ok) {
              const { history } = await histRes.json() as { history: any[] };
              if (Array.isArray(history) && history.length > 0) {
                // Upsert events — avoid duplicates on repeated /end calls
                const existing = await prisma.event.findMany({
                  where: { sessionId: id, eventType: 'command_executed' },
                  select: { metadata: true },
                });
                const existingCmds = new Set(
                  existing.map((e: any) => `${(e.metadata as any)?.command}|${(e.metadata as any)?.startedAt}`)
                );
                const toInsert = history.filter((h: any) =>
                  !existingCmds.has(`${h.command}|${h.startedAt}`)
                );
                if (toInsert.length > 0) {
                  await prisma.event.createMany({
                    data: toInsert.map((h: any) => ({
                      sessionId: id,
                      eventType: 'command_executed',
                      timestamp: new Date(h.startedAt ?? Date.now()),
                      metadata: {
                        command: h.command,
                        cwd: h.cwd,
                        exitCode: h.exitCode,
                        stdout: (h.stdout ?? '').slice(0, 2000),
                        stderr: (h.stderr ?? '').slice(0, 1000),
                        success: h.success,
                        finishedAt: h.finishedAt,
                        source: 'container_exec_history',
                      },
                    })),
                    skipDuplicates: true,
                  });
                  logger.log(`[Session End] Saved ${toInsert.length} terminal commands from container for session ${id}`);
                }
              }
            }
          } catch (e: any) {
            logger.warn('[Session End] Could not collect exec history from container:', e.message);
          }
        }

        // ── 2. Lock any Google Docs/Sheets to read-only ───────────────────────
        try {
          const { lockGoogleFile } = await import('../services/google-auth');
          const { getToolResources, markToolLocked } = await import('../services/tool-resources');
          const tools = getToolResources(current);
          for (const [toolId, resource] of Object.entries(tools)) {
            if (resource.resourceId && !resource.lockedAt) {
              await lockGoogleFile(resource.resourceId);
              await markToolLocked(prisma, id, toolId);
            }
          }
        } catch (e: any) {
          logger.warn('[Session End] Failed to lock Google files:', e.message);
        }

        // ── 3. Gemini multimodal screenshare analysis (runs FIRST so findings feed into agents) ──
        let geminiVideoAnalysis: any = null;
        try {
          const { analyzeSessionVideo } = await import('../services/gemini-video-analysis');
          logger.log(`[Session End] Running Gemini screenshare video analysis for session ${id}...`);
          geminiVideoAnalysis = await analyzeSessionVideo(id);
          if (geminiVideoAnalysis) {
            logger.log(`[Session End] ✅ Gemini video analysis complete — verdict: ${geminiVideoAnalysis.overallVerdict}`);
          } else {
            logger.log(`[Session End] No Gemini video analysis produced for session ${id} (no screenshare or API unavailable)`);
          }
        } catch (e: any) {
          logger.warn('[Session End] Gemini video analysis failed:', e.message);
        }

        // ── 4. Auto-trigger agent analysis (enriched with Gemini findings) ──────
        // Runs all Server C agents. geminiVideoAnalysis findings are now available
        // in the DB context that agents read, so the GPT-4o judge sees video evidence.
        try {
          const existing = await prisma.agentInsight.findUnique({ where: { sessionId: id } });
          if (!existing) {
            // Store Gemini result first so agents can read it during their analysis
            if (geminiVideoAnalysis) {
              await prisma.agentInsight.create({
                data: {
                  sessionId: id,
                  geminiVideoAnalysis: geminiVideoAnalysis as any,
                  computedAt: new Date(),
                  version: 1,
                },
              });
            }

            logger.log(`[Session End] Auto-triggering agent analysis for session ${id}...`);
            const { watchSession, executeAnalysis, flagSanityChecks } = await import('../mcp/servers/serverC');
            const [watcher, extractor, sanity] = await Promise.all([
              watchSession(id, true, true).catch((err: any) => {
                logger.warn('[Session End] Watcher agent error:', err.message);
                return { success: false, error: err.message, violations: [], riskScore: 0 };
              }),
              executeAnalysis(id).catch((err: any) => {
                logger.warn('[Session End] Extractor agent error:', err.message);
                return { success: false, error: err.message, behaviorScore: 0 };
              }),
              flagSanityChecks(id).catch((err: any) => {
                logger.warn('[Session End] Sanity agent error:', err.message);
                return { success: false, error: err.message, redFlags: [], riskScore: 0 };
              })
            ]);

            await prisma.agentInsight.upsert({
              where: { sessionId: id },
              update: {
                watcher: watcher as any,
                extractor: extractor as any,
                sanity: sanity as any,
                updatedAt: new Date(),
              },
              create: {
                sessionId: id,
                watcher: watcher as any,
                extractor: extractor as any,
                sanity: sanity as any,
                geminiVideoAnalysis: geminiVideoAnalysis as any,
                computedAt: new Date(),
                version: 1,
              },
            });
            logger.log(`[Session End] ✅ Agent insights stored for session ${id}`);

            // Fire Server C multi-agent pipeline (non-blocking)
            // Load full session data and pass it — Server C has no DB access
            prisma.session.findUnique({
              where: { id },
              include: {
                assessment: { include: { templateRef: true } },
                aiInteractions: { orderBy: { timestamp: 'asc' } },
                codeSnapshots: { orderBy: { timestamp: 'asc' } },
                events: { orderBy: { timestamp: 'asc' } },
              },
            }).then((sess) => {
              if (!sess) return;
              const sessionData = {
                sessionId: sess.id,
                candidateName: sess.candidateName ?? undefined,
                candidateEmail: sess.candidateEmail ?? undefined,
                startedAt: sess.startedAt ?? undefined,
                submittedAt: sess.submittedAt ?? undefined,
                timeLimit: sess.timeLimit,
                finalCode: sess.finalCode ?? undefined,
                aiInteractions: sess.aiInteractions.map((ai: any) => ({
                  id: ai.id,
                  eventType: ai.eventType,
                  promptText: ai.promptText ?? undefined,
                  responseText: ai.responseText ?? undefined,
                  model: ai.model ?? undefined,
                  promptTokens: ai.promptTokens ?? undefined,
                  completionTokens: ai.completionTokens ?? undefined,
                  latencyMs: ai.latencyMs ?? undefined,
                  timestamp: ai.timestamp,
                  tabId: ai.tabId ?? undefined,
                  conversationTurn: ai.conversationTurn ?? undefined,
                  // Code diffs — critical for diff_analyzer and response_analyzer
                  codeSnippet: ai.codeSnippet ?? undefined,
                  codeBefore: ai.codeBefore ?? undefined,
                  codeAfter: ai.codeAfter ?? undefined,
                })),
                codeSnapshots: sess.codeSnapshots.map((snap: any) => ({
                  id: snap.id,
                  timestamp: snap.timestamp,
                  code: snap.code ?? undefined,
                  linesOfCode: snap.lineCount ?? undefined,
                })),
                events: sess.events.map((ev: any) => ({
                  id: ev.id,
                  eventType: ev.eventType,
                  timestamp: ev.timestamp,
                  metadata: ev.metadata ?? undefined,
                  // Include code diffs stored in event metadata (file_modified events)
                  codeSnippet: (ev.metadata as any)?.codeSnippet ?? undefined,
                  codeBefore: (ev.metadata as any)?.codeBefore ?? undefined,
                  codeAfter: (ev.metadata as any)?.codeAfter ?? undefined,
                })),
                assessment: sess.assessment ? {
                  jobTitle: sess.assessment.jobTitle ?? undefined,
                  role: sess.assessment.role ?? undefined,
                  level: sess.assessment.level ?? undefined,
                  techStack: sess.assessment.techStack ?? undefined,
                  template: sess.assessment.template ?? undefined,
                  // ── Manifest: canonical bug list from Server B, needed by bugFixAgent + taskDifficultyAgent
                  // Try templateRef first (new path), then inline template (legacy path)
                  assessmentManifest: (() => {
                    const tRef = (sess.assessment as any).templateRef?.templateSpec as any;
                    if (tRef?.assessmentManifest) return tRef.assessmentManifest;
                    const inline = sess.assessment.template as any;
                    return inline?.templateSpec?.assessmentManifest || inline?.assessmentManifest || null;
                  })(),
                } : undefined,
                // ── Gemini video analysis — already computed, now fed into the orchestrator
                // so the Structuring Agent and Judge see video evidence before making verdict
                videoAnalysis: geminiVideoAnalysis ? {
                  overallRisk: geminiVideoAnalysis.overallVerdict === 'focused'
                    ? 'low'
                    : geminiVideoAnalysis.overallVerdict === 'somewhat_distracted'
                    ? 'medium'
                    : 'high',
                  suspiciousActivities: geminiVideoAnalysis.suspiciousActivity ?? [],
                  verdict: geminiVideoAnalysis.overallVerdict ?? 'unknown',
                  confidence: geminiVideoAnalysis.confidence === 'high' ? 0.9
                    : geminiVideoAnalysis.confidence === 'medium' ? 0.6 : 0.3,
                  frameCount: geminiVideoAnalysis.framesAnalyzed ?? 0,
                } : undefined,
              };

              const serverCUrl = `http://localhost:${process.env.SERVER_C_PORT ?? 3002}/analyze`;
              return fetch(serverCUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: id, sessionData }),
              });
            })
              .then((r: any) => r?.json())
              .then((result: any) => {
                if (!result) return;
                if (result.success && result.data) {
                  // Backend writes the insight to DB
                  return prisma.agentInsight.upsert({
                    where: { sessionId: id },
                    create: { sessionId: id, judge: result.data },
                    update: { judge: result.data, updatedAt: new Date() },
                  }).then(() => logger.log(`[Session End] ✅ Server C insight stored for ${id}`));
                } else {
                  logger.warn(`[Session End] Server C pipeline error for ${id}:`, result.error);
                }
              })
              .catch((err: any) => logger.warn(`[Session End] Server C unreachable for ${id}:`, err.message));

          } else {
            // Insights existed — still save Gemini result if we got one
            if (geminiVideoAnalysis) {
              await prisma.agentInsight.update({
                where: { sessionId: id },
                data: { geminiVideoAnalysis: geminiVideoAnalysis as any, updatedAt: new Date() },
              });
            }
            logger.log(`[Session End] Agent insights already exist for session ${id} — skipping auto-trigger`);
          }
        } catch (e: any) {
          logger.warn('[Session End] Failed to auto-trigger agent analysis:', e.message);
        }
      });
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
 * POST /api/sessions/:id/submit-files
 * Save IDE files (for WebContainer/IDE challenges).
 * This stores the candidate's current code snapshot without ending the session.
 */
router.post('/:id/submit-files', enforceTimer, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { id } = req.params;
    const { finalCode } = req.body;

    if (!finalCode || typeof finalCode !== 'string') {
      return res.status(400).json({ success: false, error: 'finalCode (JSON string) is required' });
    }

    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Save final code to session
    await prisma.session.update({
      where: { id },
      data: { finalCode: finalCode.substring(0, 5_000_000) },
    });

    // Also create a code snapshot for history
    await prisma.codeSnapshot.create({
      data: {
        sessionId: id,
        code: finalCode.substring(0, 5_000_000),
        language: 'json',
        lineCount: finalCode.split('\n').length,
      },
    });

    res.json({ success: true, message: 'Files saved' });
  } catch (error: any) {
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
      errors: [] as string[],
      /** For UI: copy each link manually when email is not configured */
      sessionLinks: [] as Array<{ email: string; name?: string; sessionCode: string; assessmentUrl: string }>
    };

    const frontendUrl = getFrontendUrl();

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
        results.sessionLinks.push({
          email: candidate.email,
          name: candidate.name,
          sessionCode,
          assessmentUrl
        });
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
        if (emailResult.success && emailResult.delivered) {
          results.emailsSent++;
        } else if (!emailResult.success) {
          results.emailsFailed++;
          results.errors.push(`Failed to send email to ${candidate.email}: ${emailResult.error}`);
        }
        // success but not delivered = no SMTP configured; session still created
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
        message:
          results.emailsSent > 0
            ? `Created ${results.created} sessions and sent ${results.emailsSent} email(s)`
            : `Created ${results.created} session(s). Share each assessment link manually (email not configured on server).`
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

// In-memory lock to prevent duplicate container creation
const provisioningLocks = new Map<string, Promise<any>>();

/**
 * POST /api/sessions/start-container
 * Provision local Docker container and create/update session
 * Uses local Docker for container provisioning with code-server
 */
router.post('/start-container', async (req: ExpressRequest, res: ExpressResponse) => {
  const { assessment_id, candidate_id, session_id, template_files } = req.body;

  // Basic rate-limiting guard: caller must supply at least one identifier.
  // If a session_id is provided, verify it exists and is not already completed/expired to
  // prevent random IDs from spinning up containers.
  if (!session_id && !candidate_id && !assessment_id) {
    return res.status(400).json({ success: false, error: 'session_id, candidate_id, or assessment_id is required' });
  }
  if (session_id) {
    const sessionCheck = await prisma.session.findUnique({
      where: { id: session_id },
      select: { id: true, status: true }
    }).catch(() => null);
    if (!sessionCheck) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    if (sessionCheck.status === 'completed' || sessionCheck.status === 'expired') {
      return res.status(409).json({ success: false, error: `Session is already ${sessionCheck.status}` });
    }
  }

  // Lock key must be stable for the same session/candidate pair.
  const lockKey =
    session_id || (candidate_id != null ? `candidate-${candidate_id}` : `temp-${Date.now()}`);

  try {
    // If another request is already provisioning for this key, wait for it.
    const existingProvision = provisioningLocks.get(lockKey);
    if (existingProvision) {
      logger.log(`[Sessions Start Container] Container already being provisioned for lock key ${lockKey}, waiting...`);
      try {
        const result = await existingProvision;
        return res.json({
          success: true,
          session: result.session,
          reused: true
        });
      } catch (error: any) {
        provisioningLocks.delete(lockKey);
        logger.warn(`[Sessions Start Container] Previous provision failed, creating new container: ${error.message}`);
      }
    }

    // IMPORTANT: Register the lock synchronously before any await. Previously we awaited
    // prisma (session reuse) before setting the lock, so two concurrent requests could both
    // pass and create two Docker containers (same shortSessionId prefix, different timestamps).
    const provisionPromise = (async () => {
      // Policy: always provision a fresh container for each assessment start.
      // Reusing stale container URLs from the DB leads to "ENOTFOUND" crashes and
      // candidates getting each other's workspaces. The in-memory provisioningLocks map
      // (set synchronously above) prevents duplicate containers within the same server
      // process lifecycle (e.g. React Strict Mode double-invocations).
      //
      // For local Docker: check if the stored container is still actually running.
      // If it is, reuse it (avoids tearing down a perfectly healthy container on every
      // hot-reload).  If not running or absent, provision fresh.
      if (session_id && USE_LOCAL_DOCKER) {
        const existingSession = await prisma.session.findUnique({
          where: { id: session_id },
          select: { containerId: true, containerUrl: true, status: true }
        });

        if (existingSession?.containerId && existingSession?.containerUrl) {
          // Verify the local Docker container is actually running — don't trust the DB alone.
          const liveUrls = await getLocalContainerUrls(existingSession.containerId);
          if (liveUrls) {
            logger.log(`[Sessions Start Container] Local container still running for session ${session_id}, reusing`);
            // Derive preview URL — use live mapped port if available, else swap to :5173
            const livePreviewUrl = (liveUrls as any).previewUrl ||
              liveUrls.ideUrl.replace(/:(\d+)\/?$/, ':5173');
            const liveDbUrl = liveUrls.ideUrl.replace(/:(\d+)\/?$/, ':5050');
            return {
              success: true,
              session: {
                ide_url: liveUrls.ideUrl,
                terminal_url: liveUrls.terminalUrl,
                preview_url: livePreviewUrl,
                db_url: liveDbUrl,
                supports_direct_preview: true,
                containerId: existingSession.containerId,
                reused: true
              }
            };
          }
          // Container gone — clear stale info before provisioning a new one
          logger.warn(`[Sessions Start Container] Stale container record for session ${session_id}, clearing and provisioning fresh`);
          await prisma.session.update({
            where: { id: session_id },
            data: { containerId: null, containerUrl: null }
          }).catch(() => {});
        }
      }
      // Azure: if a stale container URL exists in the DB for this session, check liveness first.
      // The frontend only calls start-container when the preProvisionedUrl failed its liveness
      // check. However, the GET session route may have just provisioned a container that is
      // still starting up. So: probe the stored URL — if it responds, reuse it; only clear
      // and reprovision if it is truly dead.
      if (session_id && !USE_LOCAL_DOCKER) {
        const preProvisioned = await prisma.session.findUnique({
          where: { id: session_id },
          select: { containerId: true, containerUrl: true, status: true, previewUrl: true, supportsDirectPreview: true }
        });
        if (
          preProvisioned?.containerUrl &&
          preProvisioned.status !== 'completed' &&
          preProvisioned.status !== 'expired'
        ) {
          // Probe the container — if alive, return it immediately (no second container)
          try {
            const probeRes = await fetch(preProvisioned.containerUrl, {
              method: 'HEAD',
              signal: AbortSignal.timeout(5000),
            });
            if (probeRes.ok || probeRes.status < 500) {
              logger.log(
                `[Sessions Start Container] Existing Azure container is alive for session ${session_id}, reusing`
              );
              // Use stored previewUrl if present; otherwise derive from containerUrl
              const storedPreviewUrl = preProvisioned.previewUrl ||
                preProvisioned.containerUrl!.replace(/:8080\/?$/, ':5173');
              const storedDbUrl = preProvisioned.containerUrl!.replace(/:(\d+)\/?$/, ':5050');
              return {
                success: true,
                session: {
                  ide_url: preProvisioned.containerUrl,
                  terminal_url: preProvisioned.containerUrl,
                  preview_url: storedPreviewUrl,
                  db_url: storedDbUrl,
                  supports_direct_preview: preProvisioned.supportsDirectPreview ?? false,
                  containerId: preProvisioned.containerId,
                  reused: true
                }
              };
            }
          } catch {
            // Container is not responding — fall through to reprovision
          }
          logger.log(
            `[Sessions Start Container] Clearing dead Azure container record for session ${session_id} before reprovisioning`
          );
          await prisma.session.update({
            where: { id: session_id },
            data: { containerId: null, containerUrl: null }
          }).catch(() => {});
        }
      }

      const sessionIdForContainer = session_id || `temp-${candidate_id}-${Date.now()}`;

      logger.log(`[Sessions Start Container] Provisioning ${USE_LOCAL_DOCKER ? 'local Docker' : 'Azure'} container for session: ${sessionIdForContainer}`);

      let validAssessmentId: string | null = null;
      if (assessment_id) {
        const assessment = await prisma.assessment.findUnique({
          where: { id: assessment_id },
          select: { id: true }
        });
        if (assessment) {
          validAssessmentId = assessment_id;
        } else {
          logger.warn(`[Sessions Start Container] Assessment ${assessment_id} not found, will not extract template files`);
        }
      }

      let templateFiles: Record<string, string> | undefined;
      if (template_files && typeof template_files === 'object') {
        templateFiles = template_files;
      } else if (validAssessmentId) {
        const assessment = await prisma.assessment.findUnique({
          where: { id: validAssessmentId },
          include: { templateRef: true }
        });

        if (assessment) {
          let template: any = assessment.template;
          if (typeof template === 'string') {
            try {
              template = JSON.parse(template);
            } catch (e) {
              logger.warn('Failed to parse assessment template:', e);
            }
          }

          if (template && typeof template === 'object') {
            if ('templateSpec' in template && template.templateSpec?.fileStructure) {
              templateFiles = template.templateSpec.fileStructure;
              logger.log(`[Sessions Start Container] Found ${Object.keys(templateFiles || {}).length} template files from assessment (templateSpec.fileStructure)`);
            } else if ('files' in template && typeof template.files === 'object') {
              templateFiles = template.files;
              logger.log(`[Sessions Start Container] Found ${Object.keys(templateFiles || {}).length} template files from assessment (files key)`);
            }
          }
        }
      }

      // If template files were not supplied directly or via assessment_id lookup,
      // try to resolve them from the session itself (for Azure, the GET session route
      // stores templateRef data that we can pull here).
      if ((!templateFiles || Object.keys(templateFiles).length === 0) && session_id) {
        const sessionForTemplate = await prisma.session.findUnique({
          where: { id: session_id },
          include: {
            assessment: {
              include: { templateRef: true }
            }
          }
        });
        const asmTemplate = sessionForTemplate?.assessment;
        if (asmTemplate) {
          // Try templateRef.templateSpec.fileStructure first
          const refSpec = (asmTemplate as any).templateRef?.templateSpec;
          if (refSpec?.fileStructure && typeof refSpec.fileStructure === 'object') {
            templateFiles = refSpec.fileStructure;
            logger.log(`[Sessions Start Container] Resolved ${Object.keys(templateFiles!).length} template files from session templateRef.templateSpec`);
          } else if ((asmTemplate as any).templateRef?.files && typeof (asmTemplate as any).templateRef?.files === 'object') {
            templateFiles = (asmTemplate as any).templateRef.files;
            logger.log(`[Sessions Start Container] Resolved ${Object.keys(templateFiles!).length} template files from session templateRef.files`);
          } else {
            // Try inline assessment template
            let inlineTemplate: any = (asmTemplate as any).template;
            if (typeof inlineTemplate === 'string') {
              try { inlineTemplate = JSON.parse(inlineTemplate); } catch { inlineTemplate = null; }
            }
            if (inlineTemplate?.templateSpec?.fileStructure) {
              templateFiles = inlineTemplate.templateSpec.fileStructure;
              logger.log(`[Sessions Start Container] Resolved ${Object.keys(templateFiles!).length} template files from session assessment.template.templateSpec`);
            } else if (inlineTemplate?.files && typeof inlineTemplate.files === 'object') {
              templateFiles = inlineTemplate.files;
              logger.log(`[Sessions Start Container] Resolved ${Object.keys(templateFiles!).length} template files from session assessment.template.files`);
            }
          }
        }
      }

      if (!templateFiles || Object.keys(templateFiles).length === 0) {
        logger.warn(`[Sessions Start Container] No template files found for session ${session_id} — container will have empty workspace`);
      }

      let provisionResult: any;
      if (USE_LOCAL_DOCKER) {
        logger.log(`[Sessions Start Container] Using local Docker for session ${sessionIdForContainer}`);
        provisionResult = await provisionLocalContainer(sessionIdForContainer, templateFiles);
      } else {
        logger.log(`[Sessions Start Container] Using Azure Container Instances for session ${sessionIdForContainer} (${templateFiles ? Object.keys(templateFiles).length : 0} template files)`);
        provisionResult = await provisionAssessmentContainer(sessionIdForContainer, templateFiles);
      }

      const ideUrl = provisionResult.codeServerUrl;
      // Azure containers expose the terminal through code-server's built-in terminal (no separate port).
      // Local Docker has a dedicated ttyd port on :7681.
      const terminalUrl = USE_LOCAL_DOCKER
        ? (provisionResult.terminalUrl || ideUrl.replace(':8080', ':7681'))
        : ideUrl;

      // Compute the preview URL — backend is the single source of truth, never derived client-side.
      // Azure: swap port 8080 → 5173 (direct Vite access, enabled by today's ACI port config change)
      // Local Docker: use the mapped host port returned by the provisioner
      const provisionResultAny = provisionResult as any;
      const previewUrl: string = USE_LOCAL_DOCKER
        ? (provisionResultAny.previewUrl || ideUrl.replace(/:(\d+)\/?$/, ':5173'))
        : ideUrl.replace(/:8080\/?$/, ':5173');
      const supportsDirectPreview = true; // all newly provisioned containers have port 5173 exposed

      const containerId = provisionResult.containerId;
      const containerName = provisionResult.containerGroupName;

      logger.log(`[Sessions Start Container] Container provisioned (${USE_LOCAL_DOCKER ? 'local Docker' : 'Azure'}): ${containerName}, IDE: ${ideUrl}`);

      let validCandidateId: string | null = null;
      if (candidate_id) {
        const candidate = await prisma.user.findUnique({
          where: { id: candidate_id },
          select: { id: true }
        });
        if (candidate) {
          validCandidateId = candidate_id;
        } else {
          logger.warn(`[Sessions Start Container] Candidate ${candidate_id} not found, creating session without candidateId`);
        }
      }

      let session;
      // If an explicit session_id was provided, update that session directly (handles test/sandbox sessions)
      const explicitSession = session_id
        ? await prisma.session.findUnique({ where: { id: session_id } })
        : null;

      if (explicitSession) {
        session = await prisma.session.update({
          where: { id: session_id },
          data: {
            containerId: containerId,
            containerUrl: ideUrl,
            previewUrl: previewUrl,
            supportsDirectPreview: supportsDirectPreview,
            status: 'active',
            startedAt: explicitSession.startedAt || new Date()
          },
          include: { assessment: true }
        });
      } else {
        const existingSession = await prisma.session.findFirst({
          where: {
            assessmentId: validAssessmentId,
            candidateId: validCandidateId,
            status: { in: ['pending', 'active'] }
          }
        });
        if (existingSession) {
          session = await prisma.session.update({
            where: { id: existingSession.id },
            data: {
              containerId: containerId,
              containerUrl: ideUrl,
              previewUrl: previewUrl,
              supportsDirectPreview: supportsDirectPreview,
              status: 'active',
              startedAt: existingSession.startedAt || new Date()
            },
            include: {
              assessment: true
            }
          });
        }
      }

      if (!session) {
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
          throw new Error('Failed to generate unique session code');
        }

        session = await prisma.session.create({
          data: {
            sessionCode: sessionCode,
            assessmentId: validAssessmentId,
            candidateId: validCandidateId,
            containerId: containerId,
            containerUrl: ideUrl,
            previewUrl: previewUrl,
            supportsDirectPreview: supportsDirectPreview,
            status: 'active',
            startedAt: new Date()
          },
          include: {
            assessment: true
          }
        });
      }

      logger.log(`[Sessions Start Container] Session saved: ${session.id}`);

      // Derive pgweb DB URL from ideUrl — same host, port 5050
      const dbUrl = ideUrl ? ideUrl.replace(/:(\d+)\/?$/, ':5050') : null;

      return {
        success: true,
        session: {
          ...session,
          ide_url: ideUrl,
          terminal_url: terminalUrl,
          preview_url: previewUrl,
          db_url: dbUrl,
          supports_direct_preview: supportsDirectPreview,
        }
      };

    })();

    provisioningLocks.set(lockKey, provisionPromise);
    setTimeout(() => {
      provisioningLocks.delete(lockKey);
    }, 5 * 60 * 1000);

    const result = await provisionPromise;
    provisioningLocks.delete(lockKey);

    return res.json(result);
  } catch (error: any) {
    provisioningLocks.delete(lockKey);

    logger.error('[Sessions Start Container] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to start session'
    });
  }
});

// ─── Container File API ───────────────────────────────────────────────────────
// These routes let the AI assistant read and write files inside a session's
// Docker container. The container ID is fetched from the database so the
// routes work even after a backend restart.

// ── Helper: detect whether a containerId is an Azure ACI resource path ────────
// ACI resource IDs look like:
//   /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ContainerInstance/...
// Local Docker container IDs are 64-char hex strings.
function isAzureContainerId(containerId: string): boolean {
  return containerId.startsWith('/subscriptions/') || containerId.startsWith('subscriptions/');
}

// ── Helper: derive file-server URL from containerUrl (Azure) ──────────────────
// containerUrl is http://promora-xxx.eastus.azurecontainer.io:8080
// file-server listens on port 9090 on the same host
function azureFileServerUrl(containerUrl: string): string {
  return containerUrl.replace(/:8080\/?$/, ':9090');
}

router.get('/:id/files', optionalAuthenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const session = await prisma.session.findUnique({
      where: { id: req.params.id },
      select: { containerId: true, containerUrl: true },
    });
    if (!session?.containerId) {
      return res.status(404).json({ error: 'No running container for this session' });
    }

    if (isAzureContainerId(session.containerId)) {
      // Proxy to the container's file-server on port 9090
      if (!session.containerUrl) {
        return res.status(503).json({ error: 'Container URL not available' });
      }
      const token = fileServerToken(req.params.id);
      const upstream = await fetch(`${azureFileServerUrl(session.containerUrl)}/files`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      const data = await upstream.json();
      if (!upstream.ok) return res.status(upstream.status).json(data);
      return res.json(data);
    }

    const files = await listContainerFiles(session.containerId);
    return res.json({ files });
  } catch (error: any) {
    logger.error('[Session Files] list error:', error);
    return res.status(500).json({ error: error.message || 'Failed to list files' });
  }
});

router.get('/:id/files/*', optionalAuthenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const filePath = (req.params as any)[0] as string;
    if (!filePath) return res.status(400).json({ error: 'File path required' });

    const session = await prisma.session.findUnique({
      where: { id: req.params.id },
      select: { containerId: true, containerUrl: true },
    });
    if (!session?.containerId) {
      return res.status(404).json({ error: 'No running container for this session' });
    }

    if (isAzureContainerId(session.containerId)) {
      if (!session.containerUrl) {
        return res.status(503).json({ error: 'Container URL not available' });
      }
      const token = fileServerToken(req.params.id);
      const upstream = await fetch(`${azureFileServerUrl(session.containerUrl)}/files/${filePath}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      const data = await upstream.json();
      if (!upstream.ok) return res.status(upstream.status).json(data);
      return res.json(data);
    }

    const content = await readContainerFile(session.containerId, filePath);
    return res.json({ path: filePath, content });
  } catch (error: any) {
    logger.error('[Session Files] read error:', error);
    return res.status(500).json({ error: error.message || 'Failed to read file' });
  }
});

router.put('/:id/files/*', optionalAuthenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const filePath = (req.params as any)[0] as string;
    const { content } = req.body as { content?: string };
    if (!filePath) return res.status(400).json({ error: 'File path required' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required in body' });

    const session = await prisma.session.findUnique({
      where: { id: req.params.id },
      select: { containerId: true, containerUrl: true },
    });
    if (!session?.containerId) {
      return res.status(404).json({ error: 'No running container for this session' });
    }

    if (isAzureContainerId(session.containerId)) {
      if (!session.containerUrl) {
        return res.status(503).json({ error: 'Container URL not available' });
      }
      const token = fileServerToken(req.params.id);
      const upstream = await fetch(`${azureFileServerUrl(session.containerUrl)}/files/${filePath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await upstream.json();
      if (!upstream.ok) return res.status(upstream.status).json(data);
      return res.json(data);
    }

    await writeContainerFile(session.containerId, filePath, content);
    return res.json({ success: true, path: filePath });
  } catch (error: any) {
    logger.error('[Session Files] write error:', error);
    return res.status(500).json({ error: error.message || 'Failed to write file' });
  }
});

// ── POST /sessions/:id/exec — run a command in the candidate container ────────
// Used by the AI chatbot to run npm test, pytest, etc. and read the output.
// Body: { command: string, cwd?: string, timeout?: number }
router.post('/:id/exec', optionalAuthenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { command, cwd, timeout } = req.body as { command?: string; cwd?: string; timeout?: number };
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'command (string) required in body' });
    }

    const session = await prisma.session.findUnique({
      where: { id: req.params.id },
      select: { containerId: true, containerUrl: true },
    });
    if (!session?.containerId) {
      return res.status(404).json({ error: 'No running container for this session' });
    }

    if (isAzureContainerId(session.containerId)) {
      if (!session.containerUrl) {
        return res.status(503).json({ error: 'Container URL not available' });
      }
      const token = fileServerToken(req.params.id);
      const upstream = await fetch(`${azureFileServerUrl(session.containerUrl)}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ command, cwd, timeout }),
        signal: AbortSignal.timeout((timeout || 30000) + 5000), // +5s grace
      });
      const data = await upstream.json();
      if (!upstream.ok) return res.status(upstream.status).json(data);
      return res.json(data);
    }

    // Local Docker: run via docker exec
    const { execInContainer } = await import('../services/local-docker-provisioner');
    const bashCmd = cwd ? `cd /home/candidate/workspace/${cwd} && ${command}` : command;
    const output = await execInContainer(session.containerId, ['bash', '-c', bashCmd]);
    return res.json({ command, exitCode: 0, stdout: output, stderr: '', success: true });
  } catch (error: any) {
    logger.error('[Session Exec] error:', error);
    return res.status(500).json({ error: error.message || 'Failed to execute command' });
  }
});

// ── GET /sessions/:id/exec/history — last N command results ──────────────────
router.get('/:id/exec/history', optionalAuthenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const n = Math.min(parseInt(req.query.n as string || '10'), 20);
    const session = await prisma.session.findUnique({
      where: { id: req.params.id },
      select: { containerId: true, containerUrl: true },
    });
    if (!session?.containerId) {
      return res.status(404).json({ error: 'No running container for this session' });
    }

    if (isAzureContainerId(session.containerId)) {
      if (!session.containerUrl) {
        return res.status(503).json({ error: 'Container URL not available' });
      }
      const token = fileServerToken(req.params.id);
      const upstream = await fetch(`${azureFileServerUrl(session.containerUrl)}/exec/history?n=${n}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      const data = await upstream.json();
      if (!upstream.ok) return res.status(upstream.status).json(data);
      return res.json(data);
    }

    return res.json({ history: [] }); // local Docker has no history endpoint
  } catch (error: any) {
    logger.error('[Session Exec History] error:', error);
    return res.status(500).json({ error: error.message || 'Failed to get exec history' });
  }
});

export default router;
