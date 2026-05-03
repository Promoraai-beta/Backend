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

export interface DimensionScore {
  weight: number;
  max_score: number;
  raw_score: number;
  weighted_score: number;
}

export interface BugNarrative {
  bugId: string;
  description: string;
  score: number;
  discovery: { discovered: boolean; firstMentionedAt: string | null; mentionCount: number };
  aiAssistance: { usedAI: boolean; chainTypes: string[]; blindlyFollowed: boolean; adapted?: boolean };
  fixQuality: string;
  finalFixed: boolean;
  verification: { verified: boolean; method: string };
  timeline: Array<{ timestamp: string; event: string; detail: string }>;
  narrativeText: string;
}

export interface FluencyAnalysis {
  chainSummary: {
    totalChains: number;
    fluencyScore: number;
    verifiedRate: number;
    blindPasteRate: number;
    adaptedRate: number;
    referenceOnlyRate: number;
    chainTypes: Record<string, number>;
  };
  temporalProgression: {
    progression: string;
    earlyScore?: number;
    lateScore?: number;
  };
  workflowPatterns: {
    firstActions: string[];
    exploredFirst: boolean;
    ranTestsEarly: boolean;
  };
  adaptationScore: {
    averageDepth: number;
    totalModifications: number;
    assessment: string;
  };
}

export interface ScoreWithManifestResult {
  success: boolean;
  sessionId: string;
  scorerVersion: string;
  assessmentType: string;
  role: string;
  overallScore: number;
  dimensionScores: Record<string, DimensionScore>;

  // Deep analysis (v2)
  bugNarratives: Record<string, BugNarrative>;
  fluencyAnalysis: FluencyAnalysis;
  responseAnalysis: {
    usagePattern: { pattern: string; breakdown: Record<string, number>; dominantCategory: string };
    adoptionPatterns: { verbatimRate: number; adaptedRate: number; totalPastesChecked: number };
    responseQuality: { codeHeavy: number; explanationHeavy: number; mixed: number; codeHeavyRatio: number };
  };
  terminalAnalysis: {
    testBehavior: { totalTestRuns: number; assessment: string; ranTestsBeforeFixing: boolean; ranTestsAfterFixing: boolean };
    engagementScore: { score: number; assessment: string };
    devServer: { started: boolean };
  };
  codeOrigins: { aiPastedChars: number; selfWrittenChars: number; aiCodeRatio: number; assessment: string };
  fileChangeMap: Record<string, { editCount: number; linesAdded: number; linesRemoved: number; aiPasteCount: number; selfEditCount: number }>;

  // Backward-compatible fields
  bugDiscovery: {
    totalBugs: number;
    bugsFound: number;
    bugsFixed: number;
    bugsMissed: number;
    discoveryRate: number;
    fixRate: number;
    details: { found: string[]; fixed: string[]; missed: string[] };
  };
  checkpointResults: {
    totalCheckpoints: number;
    completed: number;
    completionRate: number;
    details: Array<{ checkpointId: string; prompt: string; score: number; addressed: boolean }>;
  };
  behaviorAnalysis: {
    behaviorScore: number;
    totalPrompts: number;
    blindTrustRatio: number;
    promptBreakdown: Record<string, number>;
    assessment: string;
    adaptationDepth: number;
    adaptationAssessment: string;
  };
  codeQuality: {
    score: number;
    totalFiles: number;
    totalLines: number;
    totalComments: number;
    hasTests: boolean;
    hasErrorHandling: boolean;
  };
  strengths: string[];
  weaknesses: string[];
  confidence: number;
  explanation: string;
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

/**
 * Score a session against the assessment manifest (contract from Server B).
 * This is the core of trustworthy scoring — comparing candidate work to known injected bugs.
 */
export async function scoreWithManifest(
  sessionId: string,
  manifest: Record<string, any>,
  finalFiles?: Record<string, string>
): Promise<ScoreWithManifestResult> {
  try {
    const clientManager = getMCPClientManager();
    const client = await clientManager.getClient('server-c-monitoring');

    const params: Record<string, any> = { sessionId, manifest };
    if (finalFiles) {
      params.finalFiles = finalFiles;
    }

    const result = await client.callTool('score_with_manifest', params);
    return result as ScoreWithManifestResult;
  } catch (error: any) {
    throw new Error(error.message || 'Failed to score with manifest');
  }
}

