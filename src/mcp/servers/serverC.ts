/**
 * MCP Server C Client - Live Monitoring
 * 
 * Provides functions to interact with Server C (Real-time Monitoring, Code Analysis, Risk Assessment)
 */

import { getMCPClientManager } from '../client';

export interface WatchSessionResult {
  success: boolean;
  violations: Array<{
    severity: 'high' | 'medium' | 'low';
    type: string;
    description: string;
    timestamp: string;
  }>;
  riskScore: number;
  alerts: Array<{
    severity: string;
    message: string;
    type: string;
  }>;
  timeline?: any[];
  metrics?: any;
  confidence?: number;
  evidence?: string[];
  explanation?: string;
}

export interface ExecuteAnalysisResult {
  success: boolean;
  codeQuality: {
    totalLines?: number;
    nonEmptyLines?: number;
    comments?: number;
    commentRatio?: number;
    complexity?: string;
    maxIndentation?: number;
  };
  patterns: {
    copyPastePatterns?: any[];
    timingPatterns?: any;
    promptPatterns?: any;
  };
  codeIntegration: {
    modifications?: number;
    copies?: number;
    modificationRatio?: number;
    integrationQuality?: string;
  };
  behaviorScore: number;
  skills?: any;
  confidence?: number;
  explanation?: string;
}

export interface FlagSanityChecksResult {
  success: boolean;
  violations: Array<{
    severity: 'high' | 'medium' | 'low';
    type: string;
    description: string;
    timestamp: string;
  }>;
  riskScore: number;
  redFlags: Array<{
    type: string;
    description: string;
    severity: string;
  }>;
  anomalies?: any[];
  plagiarismAnalysis?: any;
  sanityChecks?: any;
  confidence?: number;
  explanation?: string;
}

/**
 * Watch session for violations
 */
export async function watchSession(
  sessionId: string,
  includeFileOperations: boolean = true,
  includeTerminalEvents: boolean = true
): Promise<WatchSessionResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-c-monitoring');
    
    const result = await client.callTool('watch_session', {
      sessionId,
      includeFileOperations,
      includeTerminalEvents
    });
    return result as WatchSessionResult;
  } catch (error: any) {
    throw new Error(error.message || 'Failed to watch session');
  }
}

/**
 * Execute code analysis
 */
export async function executeAnalysis(
  sessionId: string,
  code?: string
): Promise<ExecuteAnalysisResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-c-monitoring');
    
    const result = await client.callTool('execute_analysis', {
      sessionId,
      code
    });
    return result as ExecuteAnalysisResult;
  } catch (error: any) {
    throw new Error(error.message || 'Failed to execute analysis');
  }
}

/**
 * Flag sanity checks
 */
export async function flagSanityChecks(
  sessionId: string,
  events?: any[]
): Promise<FlagSanityChecksResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-c-monitoring');
    
    const result = await client.callTool('flag_sanity_checks', {
      sessionId,
      events
    });
    return result as FlagSanityChecksResult;
  } catch (error: any) {
    throw new Error(error.message || 'Failed to flag sanity checks');
  }
}

