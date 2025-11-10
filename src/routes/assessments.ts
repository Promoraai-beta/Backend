import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import {
  verifyJobPosting,
  generateAssessments,
  analyzeJobPipeline,
  JobVerificationResult,
  AssessmentGenerationResult
} from '../mcp/servers/serverA';
import {
  buildCompleteTemplate,
  WebContainerStructureResult
} from '../mcp/servers/serverB';
import { templateBuilder } from '../services/template-builder';
import { authenticate, requireRole, checkAssessmentOwnership } from '../middleware/rbac';
import { validateAssessmentGeneration, handleValidationErrors } from '../middleware/validation';
import { apiLimiter } from '../middleware/rate-limiter';
import { findOrCreateTemplate, updateTemplateBuildStatus } from '../lib/template-utils';
import { logger } from '../lib/logger';

const router = Router();

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
    const { url, jobTitle, company, jobDescription, sourceType } = req.body;

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
        verification.jobDescription
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
      assessments = await generateAssessments(jobTitle, finalCompany, jobDescription);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Either url (recruiters only) or (jobTitle, jobDescription) must be provided'
      });
    }

    // Step 3: Use MCP Server B to build complete WebContainer structure
    let enhancedTemplateSpec: WebContainerStructureResult | null = null;
    let templateBuildError: string | null = null;
    
    if (assessments.suggestedAssessments && assessments.suggestedAssessments.length > 0) {
      try {
        // Determine language from tech stack and assessment type
        const techStack = assessments.stack || [];
        const suggestedAssessments = assessments.suggestedAssessments || [];
        
        // Check if any assessment is a React/Frontend debugging challenge
        const isReactChallenge = suggestedAssessments.some((a: any) => 
          a.title?.toLowerCase().includes('react') || 
          a.title?.toLowerCase().includes('debug') ||
          a.components?.some((c: string) => c.toLowerCase().includes('bug') || c.toLowerCase().includes('debug'))
        );
        
        // Check if React is in tech stack
        const hasReact = techStack.some(t => t.toLowerCase().includes('react'));
        const hasJavaScript = techStack.some(t => 
          t.toLowerCase().includes('javascript') || 
          t.toLowerCase().includes('js') ||
          t.toLowerCase().includes('typescript')
        );
        
        let language = 'javascript';
        // Prioritize React/JavaScript for React challenges
        if (isReactChallenge || hasReact || (hasJavaScript && !techStack.some(t => t.toLowerCase().includes('python')))) {
          // Check for TypeScript preference
          if (techStack.some(t => t.toLowerCase().includes('typescript'))) {
            language = 'typescript';
          } else {
            language = 'javascript';
          }
        } else if (techStack.some(t => t.toLowerCase().includes('python'))) {
          language = 'python';
        } else if (techStack.some(t => t.toLowerCase().includes('typescript'))) {
          language = 'typescript';
        } else if (techStack.some(t => t.toLowerCase().includes('java'))) {
          language = 'java';
        }
        
        logger.log(`🔨 Building WebContainer structure with MCP Server B (language: ${language})...`);
        
        // Extract role and level from assessment metadata
        const jobRole = assessments.role || 'Frontend Developer';
        const experienceLevel = assessments.level || 'Mid-level';
        const complexity = 'medium'; // Could be extracted from assessment level
        
        // Call MCP Server B to build complete template
        // Pass original templateSpec if available to extract dependencies
        // Now includes role-based project generation
        enhancedTemplateSpec = await buildCompleteTemplate(
          assessments.suggestedAssessments,
          techStack,
          language,
          assessments.templateSpec,
          jobRole,
          experienceLevel,
          complexity
        );
        
        logger.log(`✅ WebContainer structure built: ${Object.keys(enhancedTemplateSpec.fileStructure).length} files`);
      } catch (error: any) {
        logger.error('❌ MCP Server B failed:', error);
        templateBuildError = error.message;
        // Continue with original templateSpec if Server B fails
      }
    }

    // Use enhanced templateSpec if available, otherwise use original
    const finalTemplateSpec = enhancedTemplateSpec || assessments.templateSpec;

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
        template: templateId ? null : { // Only store inline if no template reference
          suggestedAssessments: assessments.suggestedAssessments,
          templateSpec: finalTemplateSpec || assessments.templateSpec
        } as any,
        sourceUrl: url || null,
        sourceType: finalSourceType,
        assessmentType: assessmentType, // 'recruiter' or 'candidate' - distinguishes creation context
        isActive: true, // New assessments are active by default
        createdBy: userId // Track who created the assessment (recruiter or candidate)
      },
      include: {
        company: true,
        templateRef: true // Include template reference
      }
    });

    // Build Docker template if needed (for backend languages)
    // IMPORTANT: Only build if template doesn't already exist or isn't built yet
    let templateBuildResult = null;
    if (finalTemplateSpec && typeof finalTemplateSpec === 'object') {
      try {
        // Use template ID from database if available, otherwise use assessment ID (legacy)
        const buildTemplateId = template?.id ? template.id : `template-${assessment.id}`;
        
        // Only build Docker for backend languages that need Code-Server
        const runtime = (finalTemplateSpec as any).runtime?.toLowerCase() || '';
        const needsDocker = runtime && 
          ['python', 'java', 'go', 'rust', 'csharp', 'openjdk', 'golang'].some(
            lang => runtime.includes(lang)
          ) && !runtime.includes('browser') && !runtime.includes('node');
        
        if (needsDocker) {
          // Check if template already has Docker image built
          if (template?.dockerImageBuilt && template?.dockerImage) {
            logger.log(`✅ Reusing existing Docker template: ${template.dockerImage}`);
            templateBuildResult = {
              templateId: buildTemplateId,
              status: 'ready',
              type: 'docker',
              dockerImage: template.dockerImage,
              reused: true,
              message: 'Docker template reused from cache'
            };
          } else {
            // Build Docker image (only if not already built)
            logger.log(`⏳ Building Docker template for assessment ${assessment.id}...`);
            
            // Update template status to 'building'
            if (template) {
              await updateTemplateBuildStatus(template.id, 'building');
            }
            
            const buildResult = await templateBuilder.buildTemplate(buildTemplateId, finalTemplateSpec as any);
            
            if (buildResult.status === 'ready') {
              logger.log(`✅ Docker template built successfully: ${buildResult.dockerImage}`);
              
              // Update template with build result
              if (template) {
                await updateTemplateBuildStatus(
                  template.id,
                  'ready',
                  buildResult.dockerImage
                );
              }
              
              templateBuildResult = {
                templateId: buildTemplateId,
                status: buildResult.status,
                type: 'docker',
                dockerImage: buildResult.dockerImage,
                buildTime: buildResult.buildTime,
                imageSize: buildResult.imageSize,
                reused: false,
                message: 'Docker template built and ready'
              };
            } else {
              // Update template with error
              if (template) {
                await updateTemplateBuildStatus(
                  template.id,
                  'failed',
                  undefined,
                  buildResult.error || 'Unknown error'
                );
              }
              throw new Error(`Docker template build failed: ${buildResult.error || 'Unknown error'}`);
            }
          }
        } else {
          // WebContainer-based (React, Vue, Node.js, etc.) - verify templateSpec is complete
          const hasFileStructure = finalTemplateSpec && 
            typeof finalTemplateSpec === 'object' && 
            'fileStructure' in finalTemplateSpec &&
            Object.keys((finalTemplateSpec as any).fileStructure || {}).length > 0;
          
          if (!hasFileStructure) {
            throw new Error('WebContainer template spec is incomplete - missing fileStructure');
          }
          
          // Mark template as webcontainer ready if it exists
          if (template && !template.webcontainerReady) {
            await prisma.template.update({
              where: { id: template.id },
              data: { 
                webcontainerReady: true,
                buildStatus: 'ready'
              }
            });
          }
          
          templateBuildResult = {
            status: 'ready',
            type: 'webcontainer',
            templateId: buildTemplateId,
            templateSpec: finalTemplateSpec,
            fileCount: Object.keys((finalTemplateSpec as any).fileStructure || {}).length,
            reused: template?.webcontainerReady || false,
            message: 'WebContainer template ready - no Docker build needed'
          };
          logger.log(`✅ WebContainer template ready (${Object.keys((finalTemplateSpec as any).fileStructure || {}).length} files)${template?.webcontainerReady ? ' - reused' : ''}`);
        }
      } catch (error: any) {
        logger.error('Failed to build template:', error);
        
        // Update template status if it exists
        if (template) {
          await updateTemplateBuildStatus(
            template.id,
            'failed',
            undefined,
            error.message
          );
        }
        
        // Return error - don't allow session creation if template failed
        return res.status(500).json({
          success: false,
          error: `Template build failed: ${error.message}`,
          details: 'The IDE template could not be built. Please try again or check the template specification.'
        });
      }
    } else {
      // No template spec - this shouldn't happen, but handle gracefully
      logger.warn(`⚠️ No template spec available for assessment ${assessment.id}`);
      templateBuildResult = {
        status: 'ready',
        type: 'none',
        message: 'No template spec required'
      };
    }
    
    // Handle MCP Server B errors
    if (templateBuildError) {
      logger.warn(`⚠️ MCP Server B failed, using original templateSpec: ${templateBuildError}`);
    }

    // Get template data (from templateRef or inline template)
    const templateData = assessment.templateRef 
      ? {
          templateSpec: assessment.templateRef.templateSpec,
          suggestedAssessments: assessment.templateRef.suggestedAssessments,
          templateId: assessment.templateRef.id,
          templateHash: assessment.templateRef.templateHash,
          reused: assessment.templateRef.usageCount > 1
        }
      : {
          templateSpec: (assessment.template as any)?.templateSpec || assessments.templateSpec,
          suggestedAssessments: (assessment.template as any)?.suggestedAssessments || assessments.suggestedAssessments
        };
    
    // Return response with assessment template
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
        suggestedAssessments: templateData.suggestedAssessments,
        templateSpec: templateData.templateSpec,
        template: templateData, // Include full template data
        templateBuild: templateBuildResult,
        verification: verification || null,
        mcpServerBStatus: enhancedTemplateSpec ? 'success' : 'failed',
        mcpServerBError: templateBuildError || null
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

export default router;

