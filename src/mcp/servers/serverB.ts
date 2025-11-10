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

export interface WebContainerStructureResult {
  name: string;
  runtime: string;
  packageManager: string;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts: Record<string, string>;
  fileStructure: Record<string, string>;
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
 * Build complete WebContainer structure
 */
export async function buildCompleteTemplate(
  suggestedAssessments: any[],
  techStack: string[],
  language: string = 'javascript',
  existingTemplateSpec?: any,
  jobRole?: string,
  experienceLevel?: string,
  complexity: string = 'medium'
): Promise<WebContainerStructureResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-b-template-builder');
    
    // Step 1: Extract dependencies
    let dependencies: Record<string, string> = {};
    let packageManager = 'npm';
    
    if (existingTemplateSpec) {
      dependencies = existingTemplateSpec.dependencies || {};
      packageManager = existingTemplateSpec.packageManager || 'npm';
    }

    // Step 2: Validate dependencies
    const validatedDeps = await validateDependencies(dependencies, techStack, packageManager);

    // Step 3: Generate LeetCode problems (legacy support)
    const problems = await generateLeetCodeProblems(suggestedAssessments, techStack, language);

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

    const result = await client.callTool('build_webcontainer_structure', requestParams);
    return result as WebContainerStructureResult;
  } catch (error: any) {
    throw new Error(error.message || 'Failed to build complete template');
  }
}

