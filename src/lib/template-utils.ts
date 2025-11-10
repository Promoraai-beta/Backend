/**
 * Template Utility Functions
 * 
 * Provides functions for:
 * - Generating template hashes for lookup
 * - Finding or creating reusable templates
 * - Template caching and reuse
 */

import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

const prisma = new PrismaClient();

export interface TemplateLookupParams {
  role?: string;
  techStack?: string[] | string;
  level?: string;
}

/**
 * Generate a hash for template lookup based on role, techStack, and level
 * This allows us to find existing templates that match the same criteria
 */
export function generateTemplateHash(params: TemplateLookupParams): string {
  const { role = '', techStack = [], level = '' } = params;
  
  // Normalize techStack to array and sort for consistent hashing
  const stackArray = Array.isArray(techStack) 
    ? techStack.sort() 
    : (typeof techStack === 'string' ? [techStack] : []);
  
  // Create a normalized string for hashing
  const normalized = JSON.stringify({
    role: (role || '').toLowerCase().trim(),
    techStack: stackArray.map(s => s.toLowerCase().trim()),
    level: (level || '').toLowerCase().trim()
  });
  
  // Generate SHA-256 hash
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Find an existing template by hash, or return null if not found
 */
export async function findTemplateByHash(templateHash: string) {
  try {
    return await prisma.template.findUnique({
      where: { templateHash },
      include: {
        assessments: {
          select: {
            id: true,
            jobTitle: true,
            createdAt: true
          },
          take: 5, // Just get a few examples
          orderBy: { createdAt: 'desc' }
        }
      }
    });
  } catch (error) {
    logger.error('Error finding template by hash:', error);
    return null;
  }
}

/**
 * Find an existing template by role/stack/level, or return null if not found
 */
export async function findTemplateByParams(params: TemplateLookupParams) {
  const hash = generateTemplateHash(params);
  return findTemplateByHash(hash);
}

/**
 * Create a new template in the database
 */
export async function createTemplate(params: {
  role?: string;
  techStack?: string[] | string;
  level?: string;
  templateSpec: any;
  suggestedAssessments?: any[];
  dockerImage?: string;
  dockerImageBuilt?: boolean;
  webcontainerReady?: boolean;
  buildStatus?: string;
  buildError?: string;
}) {
  const { role, techStack, level, templateSpec, suggestedAssessments, dockerImage, dockerImageBuilt, webcontainerReady, buildStatus, buildError } = params;
  
  const templateHash = generateTemplateHash({ role, techStack, level });
  
  // Normalize techStack
  const stackArray = Array.isArray(techStack) 
    ? techStack 
    : (typeof techStack === 'string' ? [techStack] : []);
  
  try {
    const template = await prisma.template.create({
      data: {
        templateHash,
        role: role || null,
        techStack: stackArray.length > 0 ? stackArray : undefined,
        level: level || null,
        templateSpec,
        suggestedAssessments: suggestedAssessments || undefined,
        dockerImage: dockerImage || null,
        dockerImageBuilt: dockerImageBuilt || false,
        webcontainerReady: webcontainerReady || false,
        buildStatus: buildStatus || 'pending',
        buildError: buildError || null,
        usageCount: 0
      }
    });
    
    logger.log(`✅ Created new template with hash: ${templateHash.substring(0, 8)}...`);
    return template;
  } catch (error: any) {
    logger.error('Error creating template:', error);
    throw new Error(`Failed to create template: ${error.message}`);
  }
}

/**
 * Find or create a template
 * If a matching template exists, return it and increment usage count
 * If not, create a new one
 */
export async function findOrCreateTemplate(params: {
  role?: string;
  techStack?: string[] | string;
  level?: string;
  templateSpec: any;
  suggestedAssessments?: any[];
}) {
  const { role, techStack, level, templateSpec, suggestedAssessments } = params;
  
  // Try to find existing template
  const existingTemplate = await findTemplateByParams({ role, techStack, level });
  
  if (existingTemplate) {
    // Increment usage count
    const updated = await prisma.template.update({
      where: { id: existingTemplate.id },
      data: { usageCount: { increment: 1 } }
    });
    
    logger.log(`♻️ Reusing existing template (hash: ${existingTemplate.templateHash.substring(0, 8)}..., usage: ${updated.usageCount})`);
    return updated;
  }
  
  // Create new template
  return createTemplate({
    role,
    techStack,
    level,
    templateSpec,
    suggestedAssessments,
    webcontainerReady: templateSpec && typeof templateSpec === 'object' && 'fileStructure' in templateSpec,
    buildStatus: 'ready'
  });
}

/**
 * Update template build status (for Docker builds)
 */
export async function updateTemplateBuildStatus(
  templateId: string,
  status: 'pending' | 'building' | 'ready' | 'failed',
  dockerImage?: string,
  buildError?: string
) {
  try {
    return await prisma.template.update({
      where: { id: templateId },
      data: {
        buildStatus: status,
        dockerImage: dockerImage || undefined,
        dockerImageBuilt: status === 'ready' && !!dockerImage,
        buildError: buildError || undefined,
        updatedAt: new Date()
      }
    });
  } catch (error: any) {
    logger.error('Error updating template build status:', error);
    throw new Error(`Failed to update template build status: ${error.message}`);
  }
}

/**
 * Get template with all related data
 */
export async function getTemplateById(templateId: string) {
  try {
    return await prisma.template.findUnique({
      where: { id: templateId },
      include: {
        assessments: {
          select: {
            id: true,
            jobTitle: true,
            assessmentType: true,
            createdAt: true
          },
          take: 10,
          orderBy: { createdAt: 'desc' }
        }
      }
    });
  } catch (error) {
    logger.error('Error getting template by ID:', error);
    return null;
  }
}

