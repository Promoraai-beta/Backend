/**
 * MCP Server B Client - Template Builder
 * 
 * Provides functions to interact with Server B (Dependency Validation, Problem Generation, Project Building)
 */

import { getMCPClientManager } from '../client';

export interface DependencyValidationResult {
  validated: Record<string, string>;
  warnings: string[];
  errors: string[];
  packageManager: string;
  totalPackages: number;
  validPackages: number;
  invalidPackages: number;
}

export interface LeetCodeProblemsResult {
  [filePath: string]: string;
}

export interface AssessmentManifest {
  assessmentType: string;
  role: string;
  level: string;
  stack: string[];
  injectedBugIds: string[];
  expectedSignals: Record<string, any>;
  checkpoints: Array<{ id: string; prompt: string; order: number }>;
  scoringRubric: Record<string, { weight: number; maxScore: number }>;
  skillsMeasured: string[];
}

export interface WebContainerStructureResult {
  name: string;
  runtime: string;
  packageManager: string;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts: Record<string, string>;
  fileStructure: Record<string, string>;
  assessmentManifest?: AssessmentManifest;
  intentionalIssues?: Array<{ id: string; description: string }>;
  simulationConfig?: any;
  candidateInstructions?: string;
  setupInstructions?: string;
}

/**
 * Validate dependencies
 */
export async function validateDependencies(
  dependencies: Record<string, string>,
  techStack: string[],
  packageManager: string = 'npm'
): Promise<DependencyValidationResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-b-template-builder');
    
    const result = await client.callTool('validate_dependencies', {
      dependencies,
      techStack,
      packageManager
    });
    return result as DependencyValidationResult;
  } catch (error: any) {
    throw new Error(error.message || 'Failed to validate dependencies');
  }
}

/**
 * Generate LeetCode problems
 */
export async function generateLeetCodeProblems(
  tasks: any[],
  techStack: string[],
  language: string = 'javascript'
): Promise<LeetCodeProblemsResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-b-template-builder');
    
    const result = await client.callTool('generate_leetcode_problems', {
      tasks,
      techStack,
      language
    });
    return result as LeetCodeProblemsResult;
  } catch (error: any) {
    throw new Error(error.message || 'Failed to generate LeetCode problems');
  }
}

/**
 * Seed a sensible initial dependency dict from the tech stack so Agent 3
 * always has real packages to validate rather than an empty object.
 */
function seedDependenciesFromStack(techStack: string[]): Record<string, string> {
  const deps: Record<string, string> = {};
  const stack = techStack.map(t => t.toLowerCase());

  // React / frontend
  if (stack.some(t => ['react', 'typescript', 'javascript', 'next.js', 'nextjs', 'vite'].includes(t))) {
    Object.assign(deps, {
      'react': '^18.3.1',
      'react-dom': '^18.3.1',
      'axios': '^1.7.7',
    });
  }
  // Node / Express backend
  if (stack.some(t => ['node', 'express', 'nodejs', 'node.js'].includes(t))) {
    Object.assign(deps, {
      'express': '^4.21.0',
      'cors': '^2.8.5',
      'dotenv': '^16.4.5',
    });
  }
  // Database / ORM
  if (stack.some(t => ['postgresql', 'postgres', 'pg'].includes(t))) {
    Object.assign(deps, { 'pg': '^8.12.0' });
  }
  if (stack.some(t => ['prisma'].includes(t))) {
    Object.assign(deps, { '@prisma/client': '^5.0.0' });
  }
  if (stack.some(t => ['mongoose', 'mongodb'].includes(t))) {
    Object.assign(deps, { 'mongoose': '^8.0.0' });
  }
  // Auth
  if (stack.some(t => ['jwt', 'auth', 'jsonwebtoken'].includes(t))) {
    Object.assign(deps, { 'jsonwebtoken': '^9.0.2' });
  }

  return deps;
}

/**
 * Build complete WebContainer structure
 */
export async function buildCompleteTemplate(
  suggestedAssessments: any[],
  techStack: string[],
  language: string = 'javascript',
  existingTemplateSpec?: any,
  jobRole?: string,
  experienceLevel?: string,
  complexity: string = 'medium',
  companyName?: string,
  jobDescription?: string,
  variantIndex: number = 0,
  totalVariants: number = 1,
): Promise<WebContainerStructureResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-b-template-builder');
    
    // Step 1: Extract or seed dependencies
    let dependencies: Record<string, string> = {};
    let packageManager = 'npm';

    if (existingTemplateSpec) {
      dependencies = existingTemplateSpec.dependencies || {};
      packageManager = existingTemplateSpec.packageManager || 'npm';
    } else {
      // Seed from tech stack so Agent 3 has real packages to validate/normalise
      dependencies = seedDependenciesFromStack(techStack);
    }

    // Step 2: Validate dependencies (Agent 3)
    const validatedDeps = await validateDependencies(dependencies, techStack, packageManager);

    // Step 3: Generate LeetCode problems — only for algorithm/coding assessments, not project-based ones
    const needsLeetCode = suggestedAssessments.some((a: any) => {
      const title = (a.title || a.type || '').toLowerCase();
      const components = (a.components || []).map((c: any) => String(c).toLowerCase());
      return title.includes('algorithm') || title.includes('leetcode') || title.includes('data structure')
        || components.some((c: string) => c.includes('algorithm') || c.includes('leetcode'));
    });
    const problems = needsLeetCode
      ? await generateLeetCodeProblems(suggestedAssessments, techStack, language)
      : {};

    // Step 4: Build complete structure
    const requestParams: any = {
      tasks: suggestedAssessments,
      problems,
      validatedDeps: validatedDeps.validated,
      techStack,
      language
    };

    // Add role-based parameters if available
    if (jobRole) {
      requestParams.jobRole = jobRole;
      requestParams.experienceLevel = experienceLevel || 'Mid-level';
      requestParams.complexity = complexity;
      if (companyName) requestParams.companyName = companyName;
      if (jobDescription) requestParams.jobDescription = jobDescription.slice(0, 1000); // cap size
      // Per-request LLM toggles via env (server B also supports per-call args)
      if (process.env.USE_LLM) {
        requestParams.useLLM = process.env.USE_LLM === 'true';
      }
      if (process.env.OPENAI_MODEL) {
        requestParams.llmModel = process.env.OPENAI_MODEL;
      }
      
      // Extract skills and problem types
      const skillsToTest: string[] = [];
      const problemTypes: string[] = [];
      
      suggestedAssessments.forEach((assessment: any) => {
        const title = (assessment.title || '').toLowerCase();
        const components = (assessment.components || []).map((c: any) => String(c).toLowerCase());
        
        if (title.includes('performance') || components.some((c: string) => c.includes('performance'))) {
          skillsToTest.push('Performance');
        }
        if (title.includes('accessibility') || components.some((c: string) => c.includes('accessibility'))) {
          skillsToTest.push('Accessibility');
        }
        if (title.includes('debug') || components.some((c: string) => c.includes('bug'))) {
          problemTypes.push('bugs');
        }
        if (title.includes('optimization') || components.some((c: string) => c.includes('optimization'))) {
          problemTypes.push('optimization');
        }
      });
      
      if (skillsToTest.length > 0) {
        requestParams.skillsToTest = [...new Set(skillsToTest)];
      }
      if (problemTypes.length > 0) {
        requestParams.problemTypes = [...new Set(problemTypes)];
      }
    }

    // Pass variant context so Server B can inject the variation directive
    requestParams.variantIndex = variantIndex;
    requestParams.totalVariants = totalVariants;

    const result = await client.callTool('build_webcontainer_structure', requestParams);
    return result as WebContainerStructureResult;
  } catch (error: any) {
    throw new Error(error.message || 'Failed to build complete template');
  }
}

// ── Interfaces for SDK-based orchestration ────────────────────────────────────

export interface VariantResult {
  variantIndex: number;
  fileStructure: Record<string, string>;
  intentionalIssues: Array<{ id: string; description: string; file: string; severity: string; category: string }>;
  valid: boolean;
  validationErrors: string[];
}

/**
 * orchestrateSingleVariant
 * Calls the orchestrate_single_variant MCP tool (OpenAI Agents SDK pipeline).
 * Used for single candidate invites — generates one fresh unique template on the spot.
 */
export async function orchestrateSingleVariant(params: {
  jobRole: string;
  techStack: string[];
  experienceLevel?: string;
  complexity?: string;
  companyName?: string;
  jobDescription?: string;
  tasks?: any[];
  validatedDeps?: Record<string, string>;
  variantIndex?: number;
  numBugs?: number;
}): Promise<VariantResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-b-template-builder');

    const raw = await client.callTool('orchestrate_single_variant', {
      jobRole:         params.jobRole,
      techStack:       params.techStack,
      experienceLevel: params.experienceLevel ?? 'Mid-level',
      complexity:      params.complexity      ?? 'medium',
      companyName:     params.companyName     ?? '',
      jobDescription:  params.jobDescription  ?? '',
      tasks:           params.tasks           ?? [],
      validatedDeps:   params.validatedDeps   ?? {},
      variantIndex:    params.variantIndex    ?? 0,
      numBugs:         params.numBugs         ?? 3,
    });

    return raw as VariantResult;
  } catch (error: any) {
    throw new Error(error.message || 'orchestrateSingleVariant failed');
  }
}

/**
 * orchestrateBulkVariants
 * Calls the orchestrate_bulk_variants MCP tool (OpenAI Agents SDK pipeline).
 * Used for bulk invites — generates up to 10 unique variants in parallel.
 * 500 candidates → only ≤10 LLM calls. Round-robin assigned in sessions.ts.
 */
export async function orchestrateBulkVariants(params: {
  jobRole: string;
  techStack: string[];
  variantCount: number;
  experienceLevel?: string;
  complexity?: string;
  companyName?: string;
  jobDescription?: string;
  tasks?: any[];
  validatedDeps?: Record<string, string>;
  numBugs?: number;
}): Promise<VariantResult[]> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-b-template-builder');

    const raw = await client.callTool('orchestrate_bulk_variants', {
      jobRole:         params.jobRole,
      techStack:       params.techStack,
      variantCount:    params.variantCount,
      experienceLevel: params.experienceLevel ?? 'Mid-level',
      complexity:      params.complexity      ?? 'medium',
      companyName:     params.companyName     ?? '',
      jobDescription:  params.jobDescription  ?? '',
      tasks:           params.tasks           ?? [],
      validatedDeps:   params.validatedDeps   ?? {},
      numBugs:         params.numBugs         ?? 3,
    }) as { variants: VariantResult[] };

    return raw.variants ?? [];
  } catch (error: any) {
    throw new Error(error.message || 'orchestrateBulkVariants failed');
  }
}

