/**
 * MCP Server A Client - Job Analysis
 * 
 * Provides functions to interact with Server A (Job Analysis + Assessment Generation)
 */

import { getMCPClientManager } from '../client';

export interface JobVerificationResult {
  isValidJobPage: boolean;
  jobTitle?: string;
  company?: string;
  jobDescription?: string;
  error?: string;
}

export interface AssessmentTemplate {
  title: string;
  duration: string;
  components: string[];
}

export interface AssessmentGenerationResult {
  suggestedAssessments: AssessmentTemplate[];
  role: string;
  stack: string[];
  level: string;
  templateSpec?: any;
}

/**
 * Verify a job posting URL
 */
export async function verifyJobPosting(url: string): Promise<JobVerificationResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-a-job-analysis');
    
    const result = await client.callTool('verify_job_posting', { url });
    return result as JobVerificationResult;
  } catch (error: any) {
    return {
      isValidJobPage: false,
      error: error.message || 'Failed to verify job posting'
    };
  }
}

/**
 * Generate assessment templates from job data
 */
export async function generateAssessments(
  jobTitle: string,
  company: string,
  jobDescription: string
): Promise<AssessmentGenerationResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-a-job-analysis');
    
    const result = await client.callTool('generate_assessments', {
      jobTitle,
      company,
      jobDescription
    });
    return result as AssessmentGenerationResult;
  } catch (error: any) {
    throw new Error(error.message || 'Failed to generate assessments');
  }
}

/**
 * Complete pipeline: verify URL and generate assessments
 */
export async function analyzeJobPipeline(url: string): Promise<{
  verification: JobVerificationResult;
  assessments: AssessmentGenerationResult;
}> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-a-job-analysis');
    
    const result = await client.callTool('analyze_job_pipeline', { url });
    return result as { verification: JobVerificationResult; assessments: AssessmentGenerationResult };
  } catch (error: any) {
    // Fallback to individual calls
    const verification = await verifyJobPosting(url);
    
    if (!verification.isValidJobPage) {
      throw new Error('Invalid job posting URL');
    }

    if (!verification.jobTitle || !verification.company || !verification.jobDescription) {
      throw new Error('Incomplete job data from verification');
    }

    const assessments = await generateAssessments(
      verification.jobTitle,
      verification.company,
      verification.jobDescription
    );

    return {
      verification,
      assessments
    };
  }
}

