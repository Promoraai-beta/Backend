import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import {
  verifyJobPosting,
  generateAssessments,
  analyzeJobPipeline,
  extractSkills,
  JobVerificationResult,
  AssessmentGenerationResult
} from '../mcp/servers/serverA';
import { orchestrateBulkVariants } from '../mcp/servers/serverB';
import { authenticate, requireRole, checkAssessmentOwnership } from '../middleware/rbac';
import { validateAssessmentGeneration, handleValidationErrors } from '../middleware/validation';
import { apiLimiter } from '../middleware/rate-limiter';
import { findOrCreateTemplate, createTemplate } from '../lib/template-utils';
import { logger } from '../lib/logger';

const router = Router();

/**
 * Derives human-readable assessment tasks from intentional bugs injected by Server B.
 * Groups bugs into cohesive tasks so task descriptions always match the actual code.
 */
function deriveTasksFromIntentionalIssues(
  intentionalIssues: Array<{ id: string; description: string }>,
  candidateInstructions?: string,
  originalTasks?: any[]
): any[] {
  if (!intentionalIssues || intentionalIssues.length === 0) return originalTasks || [];

  const bugCategories: Record<string, { title: string; bugIds: string[]; descriptions: string[] }> = {};

  for (const issue of intentionalIssues) {
    let category = 'general';
    let categoryTitle = 'Fix Code Issues';

    const id = issue.id || '';
    if (id.includes('input') || id.includes('form') || id.includes('submit') || id.includes('clear')) {
      category = 'functional';
      categoryTitle = 'Fix Functional Bugs';
    } else if (id.includes('focus') || id.includes('a11y') || id.includes('accessibility') || id.includes('aria')) {
      category = 'accessibility';
      categoryTitle = 'Fix Accessibility Issues';
    } else if (id.includes('rerender') || id.includes('performance') || id.includes('memo') || id.includes('debounce')) {
      category = 'performance';
      categoryTitle = 'Optimize Performance';
    } else if (id.includes('useeffect') || id.includes('hook') || id.includes('closure') || id.includes('deps')) {
      category = 'hooks';
      categoryTitle = 'Fix React Hook Issues';
    } else if (id.includes('error') || id.includes('handling') || id.includes('api')) {
      category = 'errors';
      categoryTitle = 'Add Error Handling';
    } else if (id.includes('key') || id.includes('prop') || id.includes('missing')) {
      category = 'functional';
      categoryTitle = 'Fix Functional Bugs';
    } else if (id.includes('test') || id.includes('coverage')) {
      category = 'testing';
      categoryTitle = 'Improve Test Coverage';
    }

    if (!bugCategories[category]) {
      bugCategories[category] = { title: categoryTitle, bugIds: [], descriptions: [] };
    }
    bugCategories[category].bugIds.push(id);
    bugCategories[category].descriptions.push(issue.description);
  }

  return Object.values(bugCategories).map((cat) => ({
    title: cat.title,
    duration: 20,
    components: cat.descriptions,
    description: cat.descriptions.join(' '),
    requirements: cat.descriptions,
    bugIds: cat.bugIds,
  }));
}

/**
 * POST /api/assessments/generate
 * 
 * Option A: Generate assessment from job URL
 * Body: { url: string }
 * 
 * Option B: Generate assessment from job description
 * Body: { jobTitle: string, company: string, jobDescription: string }
 * 
 * Requires recruiter authentication
 */
// Allow both recruiters and candidates to generate assessments
// Candidates can create self-assessments, recruiters create assessments for candidates
router.post('/generate', apiLimiter, authenticate, requireRole(['recruiter', 'candidate']), validateAssessmentGeneration, async (req: Request, res: Response) => {
  try {
    const { url, jobTitle, company, jobDescription, sourceType, assessmentPreferences, variantCount: rawVariantCount } = req.body;
    // variantCount: how many unique template variants to generate (1 = single-template mode, default)
    const variantCount = (typeof rawVariantCount === 'number' && rawVariantCount > 0)
      ? Math.min(rawVariantCount, 20) // cap at 20 to avoid runaway LLM costs
      : 1;

    // Get user's profile (recruiter or candidate) - do this FIRST
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    
    let recruiterProfile = null;
    let candidateProfile = null;
    
    if (userRole === 'recruiter') {
      recruiterProfile = await prisma.recruiterProfile.findUnique({
        where: { userId },
        include: { company: true }
      });
    } else if (userRole === 'candidate') {
      candidateProfile = await prisma.candidateProfile.findUnique({
        where: { userId }
      });
    }

    let verification: JobVerificationResult | null = null;
    let assessments: AssessmentGenerationResult;

    // Option A: URL provided - verify and generate (recruiters only)
    if (url) {
      if (userRole === 'candidate') {
        return res.status(400).json({
          success: false,
          error: 'Candidates cannot create assessments from job URLs. Use job description instead.'
        });
      }

      // Step 1: Verify job posting
      verification = await verifyJobPosting(url);

      if (!verification.isValidJobPage) {
        return res.status(400).json({
          success: false,
          error: 'Invalid job posting URL',
          verification
        });
      }

      if (!verification.jobTitle || !verification.company || !verification.jobDescription) {
        return res.status(400).json({
          success: false,
          error: 'Incomplete job data extracted from URL',
          verification
        });
      }

      // Step 2: Generate assessments from verified data
      assessments = await generateAssessments(
        verification.jobTitle,
        verification.company,
        verification.jobDescription,
        assessmentPreferences,
      );
    }
    // Option B: Direct job data provided (both recruiters and candidates)
    else if (jobTitle && jobDescription) {
      // Determine company based on user role
      let finalCompany = company;
      if (userRole === 'candidate') {
        // Candidates create self-assessments - use "Self Assessment" as company
        finalCompany = 'Self Assessment';
      } else {
        // Recruiters use their company or provided company
        finalCompany = company || recruiterProfile?.company?.name || 'Your Company';
      }
      assessments = await generateAssessments(jobTitle, finalCompany, jobDescription, assessmentPreferences);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Either url (recruiters only) or (jobTitle, jobDescription) must be provided'
      });
    }

    // Template generation (Server B) is deferred to invite time (POST /api/sessions).
    // At assessment creation we only store the AI-generated task list from Server A.
    const finalTemplateSpec = assessments.templateSpec || null;

    // Create or find company - use verification company, provided company, or recruiter's company
    // For candidates creating self-assessments, create a default company or use "Self Assessment"
    let companyId = recruiterProfile?.companyId || null;
    let finalCompanyName = verification?.company || company;
    
    if (userRole === 'candidate') {
      // For candidates, use "Self Assessment" or their name
      finalCompanyName = 'Self Assessment';
    } else {
      finalCompanyName = finalCompanyName || recruiterProfile?.company?.name || 'Your Company';
    }
    
    if (finalCompanyName) {
      const existingCompany = await prisma.company.findFirst({
        where: { name: finalCompanyName }
      });
      
      if (existingCompany) {
        companyId = existingCompany.id;
      } else {
        const newCompany = await prisma.company.create({
          data: { name: finalCompanyName }
        });
        companyId = newCompany.id;
      }
      
      // Update recruiter profile with company if they don't have one (only for recruiters)
      if (userRole === 'recruiter' && !recruiterProfile?.companyId && companyId) {
        await prisma.recruiterProfile.update({
          where: { userId },
          data: { companyId: companyId }
        });
      }
    }

    // Determine assessment type based on creator role
    // 'recruiter' = created by recruiter for evaluating candidates
    // 'candidate' = created by candidate for self-practice
    const assessmentType = userRole === 'candidate' ? 'candidate' : 'recruiter';
    const finalSourceType = url ? 'url' : (sourceType === 'self-assessment' ? 'self-assessment' : 'manual');

    // Find or create reusable template
    // This allows recruiters to reuse templates when creating similar assessments
    let template = null;
    let templateId: string | null = null;
    
    if (finalTemplateSpec || assessments.templateSpec) {
      try {
        template = await findOrCreateTemplate({
          role: assessments.role,
          techStack: assessments.stack,
          level: assessments.level,
          templateSpec: finalTemplateSpec || assessments.templateSpec,
          suggestedAssessments: assessments.suggestedAssessments
        });
        templateId = template.id;
        logger.log(`📦 Using template ${templateId} (hash: ${template.templateHash.substring(0, 8)}...)`);
      } catch (error: any) {
        logger.error('⚠️ Failed to find/create template, falling back to inline storage:', error.message);
        // Fall back to storing template inline (backward compatibility)
      }
    }

    // Store assessment template in database
    // If template was found/created, reference it; otherwise store inline (legacy)
    const assessment = await prisma.assessment.create({
      data: {
        jobTitle: verification?.jobTitle || jobTitle,
        companyId: companyId,
        jobDescription: verification?.jobDescription || jobDescription,
        role: assessments.role,
        techStack: assessments.stack,
        level: assessments.level,
        templateId: templateId, // Reference to reusable template
        template: {
          // Always store full recruiter preferences here so review page can read them
          // without needing to join templateRef (which may not be loaded).
          suggestedAssessments: assessments.suggestedAssessments ?? [],
          components:        assessmentPreferences?.components       ?? [],
          bugTypes:          assessmentPreferences?.bugTypes         ?? [],
          numTasks:          assessmentPreferences?.numTasks         ?? null,
          ideLanguage:       assessmentPreferences?.ideLanguage      ?? 'typescript',
          timeLimitMinutes:  assessmentPreferences?.timeLimitMinutes ?? 60,
          skills:            assessmentPreferences?.skills           ?? [],
          // templateSpec only in legacy path (no templateRef); saved for backward compat
          ...(!templateId && { templateSpec: finalTemplateSpec || assessments.templateSpec }),
        } as any,
        sourceUrl: url || null,
        sourceType: finalSourceType,
        assessmentType: assessmentType,
        isActive: false,
        createdBy: userId,
        variantCount: variantCount > 1 ? variantCount : null, // null = single-template mode
      },
      include: {
        company: true,
        templateRef: true // Include template reference
      }
    });

    // Store additional variant templates (variant index 1..N-1)
    // Variant 0 is already stored as assessment.templateRef (the primary template)
    const generatedVariants: Array<{ index: number; result: any }> =
      (req as any)._generatedVariants || [];

    if (generatedVariants.length > 1 && template) {
      // Always create an AssessmentVariant row for variant 0 (primary) too, for consistency
      const variantRows: Array<{ assessmentId: string; templateId: string; variantIndex: number }> = [];

      for (const { index, result } of generatedVariants) {
        if (index === 0) {
          // Variant 0 is already the primary templateRef — just record it in AssessmentVariant
          variantRows.push({ assessmentId: assessment.id, templateId: template.id, variantIndex: 0 });
        } else {
          // Create a new TemplateRef for variants 1..N-1 — always fresh, never deduped
          try {
            const variantTemplate = await createTemplate({
              role:             assessments.role,
              techStack:        assessments.stack,
              level:            assessments.level,
              templateSpec:     result,
              suggestedAssessments: assessments.suggestedAssessments,
              webcontainerReady: true,
              buildStatus:      'ready',
              variantNonce:     `${Date.now()}-v${index}`,
            });
            variantRows.push({ assessmentId: assessment.id, templateId: variantTemplate.id, variantIndex: index });
            logger.log(`📦 Variant ${index} template stored: ${variantTemplate.id}`);
          } catch (err: any) {
            logger.error(`⚠️ Failed to store variant ${index}: ${err.message}`);
          }
        }
      }

      if (variantRows.length > 0) {
        await prisma.assessmentVariant.createMany({ data: variantRows, skipDuplicates: true });
        logger.log(`✅ Stored ${variantRows.length} AssessmentVariant row(s) for assessment ${assessment.id}`);
      }
    }

    // Return the created assessment. Template (code environment) is built later at invite time.
    res.json({
      success: true,
      data: {
        assessmentId: assessment.id,
        jobTitle: assessment.jobTitle,
        company: (assessment as any).company?.name || verification?.company || company || null,
        companyId: assessment.companyId,
        role: assessment.role,
        techStack: assessment.techStack,
        level: assessment.level,
        suggestedAssessments: assessments.suggestedAssessments,
        verification: verification || null,
      }
    });
  } catch (error: any) {
    logger.error('Error generating assessment:', error);
    
    // Provide more detailed error information
    let errorMessage = 'Failed to generate assessment';
    
    if (error.response) {
      // Axios error with response
      errorMessage = error.response.data?.detail || error.response.data?.error || error.response.statusText || error.message;
    } else if (error.request) {
      // Request was made but no response received (likely MCP server not running)
      errorMessage = `MCP Server connection failed. Please ensure MCP Server A is running on ${process.env.MCP_SERVER_A_URL || 'http://localhost:8001'}`;
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        code: error.code,
        status: error.response?.status
      } : undefined
    });
  }
});

/**
 * POST /api/assessments/fetch-from-url
 * Scrape a job posting URL via Server A and return jobTitle, company, jobDescription.
 * Called in URL mode before extract-skills so the recruiter sees what was pulled.
 */
router.post('/fetch-from-url', apiLimiter, authenticate, requireRole(['recruiter']), async (req: Request, res: Response) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'url is required' });
    }

    logger.log(`🌐 Fetching job from URL: ${url}`);
    const verification = await verifyJobPosting(url);

    if (!verification.isValidJobPage) {
      return res.status(400).json({
        success: false,
        error: verification.error || 'Could not read a valid job posting from that URL',
      });
    }

    if (!verification.jobTitle || !verification.jobDescription) {
      return res.status(400).json({
        success: false,
        error: 'Job title or description could not be extracted from the URL',
      });
    }

    return res.json({
      success: true,
      data: {
        jobTitle:       verification.jobTitle,
        company:        verification.company || '',
        jobDescription: verification.jobDescription,
      },
    });
  } catch (error: any) {
    logger.error('Error fetching from URL:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch from URL' });
  }
});

/**
 * POST /api/assessments/extract-skills
 * Extract skills, role, level and assessment config from a job description.
 * Called BEFORE /generate so the recruiter can preview and adjust before generating tasks.
 */
router.post('/extract-skills', apiLimiter, authenticate, requireRole(['recruiter', 'candidate']), async (req: Request, res: Response) => {
  try {
    const { jobTitle, jobDescription } = req.body;

    if (!jobTitle || !jobDescription) {
      return res.status(400).json({
        success: false,
        error: 'jobTitle and jobDescription are required',
      });
    }

    logger.log(`🔍 Extracting skills for: "${jobTitle}"`);
    const result = await extractSkills(jobTitle, jobDescription);

    return res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    logger.error('Error extracting skills:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to extract skills',
    });
  }
});

/**
 * POST /api/assessments/:id/regenerate-tasks
 * Re-run Server A task generation for an existing assessment and persist the new tasks.
 * Recruiter can call this from the review page to get fresh LLM-generated tasks.
 */
router.post('/:id/regenerate-tasks', authenticate, requireRole(['recruiter']), async (req: Request, res: Response) => {
  try {
    const assessmentId = req.params.id;
    const userId = (req as any).userId;

    // Load the assessment
    const assessment = await prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: { company: true, templateRef: true },
    });

    if (!assessment) {
      return res.status(404).json({ success: false, error: 'Assessment not found' });
    }
    if (assessment.createdBy !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized to modify this assessment' });
    }

    // Preferences: body overrides take priority, then stored template prefs, then defaults
    const storedPrefs = (assessment.template as any) || {};
    const bodyPrefs   = req.body.assessmentPreferences || {};

    const components      = bodyPrefs.components      || storedPrefs.components      || ['ide_project', 'docs'];
    const ideLanguage     = bodyPrefs.ideLanguage     || storedPrefs.ideLanguage     || 'typescript';
    const timeLimitMinutes= bodyPrefs.timeLimitMinutes|| storedPrefs.timeLimitMinutes|| 60;
    const bugTypes        = bodyPrefs.bugTypes        || storedPrefs.bugTypes        || [];
    const skills          = bodyPrefs.skills          || storedPrefs.skills          || [];

    // Determine numTasks: use stored task count from DB as the authoritative source.
    // This prevents the frontend sending stale/zero values from resetting the count.
    const storedTasks: any[] =
      storedPrefs.suggestedAssessments ||
      (assessment as any).templateRef?.suggestedAssessments ||
      [];
    const numTasks = bodyPrefs.numTasks || storedTasks.length || components.length;

    logger.log(`🔄 Regenerating tasks for assessment ${assessmentId} — components: ${components}, numTasks: ${numTasks}`);

    const result = await generateAssessments(
      assessment.jobTitle || '',
      (assessment as any).company?.name || '',
      assessment.jobDescription || '',
      { components, ideLanguage, timeLimitMinutes, numTasks, bugTypes, skills },
    );

    const newTasks = result.suggestedAssessments || [];

    // Persist the new task list in the assessment template JSON (always here for fast reads)
    await prisma.assessment.update({
      where: { id: assessmentId },
      data: {
        template: {
          ...storedPrefs,
          suggestedAssessments: newTasks,
        } as any,
      },
    });

    logger.log(`✅ Regenerated ${newTasks.length} task(s) for assessment ${assessmentId}`);

    return res.json({
      success: true,
      data: {
        tasks: newTasks,
        role: result.role,
        level: result.level,
        stack: result.stack,
        numTasks: newTasks.length,
      },
    });
  } catch (error: any) {
    logger.error('Error regenerating tasks:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to regenerate tasks',
    });
  }
});

/**
 * GET /api/assessments
 * Get all assessments
 * - Recruiters: Get recruiter assessments (their company's or created by them)
 * - Candidates: Get their own candidate assessments
 * - Admins: Get all assessments (optionally filtered by type query parameter)
 */
router.get('/', authenticate, requireRole(['recruiter', 'candidate', 'admin']), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    const typeFilter = req.query.type as string; // Optional filter: 'recruiter' or 'candidate'
    const activeFilter = req.query.active as string; // Optional filter: 'true' or 'false' (for recruiters)

    let where: any = {};

    if (userRole === 'recruiter') {
      // Get recruiter's company
      const recruiterProfile = await prisma.recruiterProfile.findUnique({
        where: { userId },
        include: { company: true }
      });

      // If recruiter profile doesn't exist, return empty array instead of 404
      // This allows new recruiters to see an empty dashboard and create assessments
      if (!recruiterProfile) {
        logger.warn(`Recruiter profile not found for user ${userId}, returning empty assessments list`);
        return res.json({
          success: true,
          data: [] // Return empty array instead of 404
        });
      }

      // Recruiters see recruiter assessments (their company's or created by them)
      // Handle null companyId properly - if no company, only show assessments created by user
      if (recruiterProfile.companyId) {
        where = {
          assessmentType: 'recruiter', // Only recruiter assessments
          OR: [
            { companyId: recruiterProfile.companyId },
            { createdBy: userId }
          ]
        };
      } else {
        // Recruiter without company - only show assessments they created
        where = {
          assessmentType: 'recruiter',
          createdBy: userId
        };
      }

      // Optional filter by active status (for recruiters)
      if (activeFilter === 'true') {
        where.isActive = true;
      } else if (activeFilter === 'false') {
        where.isActive = false;
      }
      // If activeFilter is not provided, show both active and inactive
    } else if (userRole === 'candidate') {
      // Candidates see their own candidate assessments
      where = {
        assessmentType: 'candidate', // Only candidate assessments
        createdBy: userId // Only their own
      };
      // Candidates always see active assessments (they can't deactivate)
    } else if (userRole === 'admin') {
      // Admins can see all assessments, optionally filtered by type
      if (typeFilter && (typeFilter === 'recruiter' || typeFilter === 'candidate')) {
        where.assessmentType = typeFilter;
      }
      // Optional filter by active status (for admins)
      if (activeFilter === 'true') {
        where.isActive = true;
      } else if (activeFilter === 'false') {
        where.isActive = false;
      }
      // If no type filter, show all (where remains empty)
    }

    try {
      const assessments = await prisma.assessment.findMany({
        where,
        include: {
          company: {
            select: {
              id: true,
              name: true,
              industry: true,
              size: true,
              location: true,
              website: true,
              description: true,
              logo: true,
              createdAt: true,
              updatedAt: true
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: 100 // Limit results
      });

      // Return assessments with full company object (including logo)
      // This preserves company logo and all company information
      res.json({
        success: true,
        data: assessments
      });
    } catch (queryError: any) {
      logger.error('Database query error in assessments route:', {
        error: queryError.message,
        code: queryError.code,
        meta: queryError.meta,
        where,
        userRole,
        userId
      });
      throw queryError; // Re-throw to be caught by outer catch
    }
  } catch (error: any) {
    logger.error('Error fetching assessments:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      meta: error.meta
    });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch assessments',
      details: process.env.NODE_ENV === 'development' ? {
        code: error.code,
        meta: error.meta
      } : undefined
    });
  }
});

/**
 * GET /api/assessments/:id
 * Get a specific assessment
 * - Recruiters: Can access recruiter assessments from their company
 * - Candidates: Can access their own candidate assessments
 * - Admins: Can access all assessments
 */
router.get('/:id', authenticate, requireRole(['recruiter', 'candidate', 'admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const assessment = await prisma.assessment.findUnique({
      where: { id },
      include: {
        company: true,
        templateRef: true,
        sessions: {
          select: {
            id: true,
            sessionCode: true,
            status: true,
            candidateName: true,
            createdAt: true
          }
        }
      }
    });

    if (!assessment) {
      return res.status(404).json({
        success: false,
        error: 'Assessment not found'
      });
    }

    // Check access based on assessment type and user role
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    if (userRole === 'recruiter') {
      // Recruiters can only access recruiter assessments
      if (assessment.assessmentType !== 'recruiter') {
        return res.status(403).json({
          success: false,
          error: 'Access denied. This is a candidate assessment.'
        });
      }
      // Check ownership via company or creator
      const recruiterProfile = await prisma.recruiterProfile.findUnique({
        where: { userId }
      });
      if (recruiterProfile?.companyId !== assessment.companyId && assessment.createdBy !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You do not have permission to access this assessment.'
        });
      }
    } else if (userRole === 'candidate') {
      // Candidates can only access their own candidate assessments
      if (assessment.assessmentType !== 'candidate') {
        return res.status(403).json({
          success: false,
          error: 'Access denied. This is a recruiter assessment.'
        });
      }
      if (assessment.createdBy !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. This assessment belongs to another candidate.'
        });
      }
    }
    // Admins can access all assessments (no additional checks needed)

    // Include company name for backward compatibility
    const assessmentWithCompany = {
      ...assessment,
      company: assessment.company?.name || null
    };

    res.json({
      success: true,
      data: assessmentWithCompany
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PATCH /api/assessments/:id/status
 * Update assessment status (activate/deactivate)
 * Requires: recruiter authentication and ownership
 */
router.patch('/:id/status', authenticate, requireRole(['recruiter', 'admin']), checkAssessmentOwnership, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'isActive must be a boolean value'
      });
    }

    const assessment = await prisma.assessment.update({
      where: { id },
      data: { isActive },
      include: {
        company: true
      }
    });

    res.json({
      success: true,
      data: assessment,
      message: `Assessment ${isActive ? 'activated' : 'deactivated'} successfully`
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({
        success: false,
        error: 'Assessment not found'
      });
    }
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update assessment status'
    });
  }
});

/**
 * DELETE /api/assessments/:id
 * Delete an assessment
 * Requires: recruiter authentication and ownership
 * Note: Only deletes if no active sessions exist
 */
router.delete('/:id', authenticate, requireRole(['recruiter', 'admin']), checkAssessmentOwnership, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if assessment has active sessions
    const activeSessions = await prisma.session.findFirst({
      where: {
        assessmentId: id,
        status: {
          in: ['pending', 'active']
        }
      }
    });

    if (activeSessions) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete assessment with active or pending sessions. Please deactivate it instead.'
      });
    }

    // Delete the assessment
    await prisma.assessment.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: 'Assessment deleted successfully'
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({
        success: false,
        error: 'Assessment not found'
      });
    }
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete assessment'
    });
  }
});

/**
 * POST /api/assessments/:id/generate-variants
 * Generate N unique template variants for an assessment.
 * Called by the bulk-invite flow BEFORE creating sessions so round-robin assignment works.
 * Idempotent: if variants already exist they are replaced with the new count.
 *
 * Body: { variantCount: number }  (1-20; 0 = skip / keep existing)
 */
router.post(
  '/:id/generate-variants',
  authenticate,
  requireRole(['recruiter', 'admin']),
  async (req: Request, res: Response) => {
    try {
      const { id: assessmentId } = req.params;
      const rawCount = Number(req.body.variantCount ?? 1);
      const variantCount = Math.max(1, Math.min(rawCount, 20));

      // Load the assessment to get job context for Server B
      const assessment = await prisma.assessment.findUnique({
        where: { id: assessmentId },
        include: { templateRef: true }
      });

      if (!assessment) {
        return res.status(404).json({ success: false, error: 'Assessment not found' });
      }

      logger.info(`[GenerateVariants] assessmentId=${assessmentId} requesting ${variantCount} variants via Agents SDK`);

      const techStack = Array.isArray(assessment.techStack) ? assessment.techStack as string[] : [];
      const role      = assessment.role || 'general';
      const level     = assessment.level || 'mid';
      const jd        = (assessment as any).jobDescription || '';

      // Resolve recruiter's tasks (suggestedAssessments) so Server B generates
      // codebases that match exactly what the recruiter assigned
      let recruiterTasks: any[] = [];
      if ((assessment as any).templateRef?.suggestedAssessments?.length) {
        recruiterTasks = (assessment as any).templateRef.suggestedAssessments as any[];
      } else if ((assessment as any).template) {
        const tpl = typeof (assessment as any).template === 'string'
          ? JSON.parse((assessment as any).template)
          : (assessment as any).template;
        recruiterTasks = tpl?.suggestedAssessments ?? (Array.isArray(tpl) ? tpl : []);
      }
      // numBugs = number of recruiter-assigned tasks; drives bug count per variant
      const numBugs = Math.min(10, Math.max(1, recruiterTasks.length || 3));

      logger.info(`[GenerateVariants] assessmentId=${assessmentId} requesting ${variantCount} variants numBugs=${numBugs} tasks=${recruiterTasks.length}`);

      // ── OpenAI Agents SDK bulk orchestration ──────────────────────────────
      // Generates min(variantCount, 10) unique variants in parallel (semaphore-capped).
      // Each variant: same domain (from job description), different feature area,
      // different pre-assigned bug types — candidates cannot share answers.
      // 500 candidates → still only ≤10 LLM calls. Round-robin in sessions.ts.
      const variants = await orchestrateBulkVariants({
        jobRole:        role,
        techStack,
        variantCount,
        experienceLevel: level,
        complexity:      'medium',
        jobDescription:  jd,
        tasks:           recruiterTasks,
        numBugs,
      });

      if (variants.length === 0) {
        return res.status(500).json({ success: false, error: 'All variant generation agents failed' });
      }

      logger.info(`[GenerateVariants] ${variants.length}/${variantCount} variants generated successfully`);

      // Delete old variants for a clean slate (idempotent)
      await prisma.assessmentVariant.deleteMany({ where: { assessmentId } });

      const variantRows: Array<{ assessmentId: string; templateId: string; variantIndex: number }> = [];

      for (const variant of variants) {
        // Derive tasks from Server B's intentionalIssues so the Tasks panel
        // shows the same bugs that are actually in the code — same single source of truth
        // as the README.md. Fall back to recruiter tasks only if Server B returned nothing.
        const issues: Array<{ id: string; description: string; file?: string; severity?: string; category?: string }>
          = (variant as any).intentionalIssues ?? [];
        const derivedTasks = issues.map((issue, idx) => ({
          id:          issue.id ?? `task-${idx + 1}`,
          title:       issue.description.split('.')[0].trim(),
          description: issue.description,
          duration:    20,
          difficulty:  issue.severity === 'critical' ? 'hard' : issue.severity === 'high' ? 'medium' : 'easy',
          components:  issue.file ? [issue.file] : [],
          requirements: [issue.description],
          category:    issue.category ?? 'general',
        }));
        const finalTasks = derivedTasks.length > 0 ? derivedTasks : recruiterTasks;

        // Always create a fresh Template row per variant — hash must be unique
        const createdTemplate = await createTemplate({
          role,
          techStack,
          level,
          templateSpec:     variant,
          suggestedAssessments: finalTasks,
          webcontainerReady: true,
          buildStatus:      'ready',
          variantNonce:     `${Date.now()}-v${variant.variantIndex}`,
        });

        if (createdTemplate?.id) {
          variantRows.push({ assessmentId, templateId: createdTemplate.id, variantIndex: variant.variantIndex });
        }
      }

      if (variantRows.length > 0) {
        await prisma.assessmentVariant.createMany({ data: variantRows, skipDuplicates: true });
        // Also update the primary templateRef to variant 0 if not already set
        if (variantRows[0]) {
          await prisma.assessment.update({
            where: { id: assessmentId },
            data: { templateId: variantRows[0].templateId, variantCount }
          });
        }
      }

      res.json({
        success: true,
        data: {
          assessmentId,
          variantCount: variantRows.length,
          requested: variantCount,
          variantIds: variantRows.map(v => v.templateId)
        }
      });
    } catch (error: any) {
      logger.error('[GenerateVariants] Error:', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to generate variants' });
    }
  }
);

export default router;

