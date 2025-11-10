import { Router } from 'express';
import { watchSession, executeAnalysis, flagSanityChecks } from '../mcp/servers/serverC';
import { prisma } from '../lib/prisma';
import { liveMonitoringLimiter } from '../middleware/rate-limiter';
import { authenticate, checkSessionOwnership } from '../middleware/rbac';

const router = Router();

/**
 * GET /api/live-monitoring/:sessionId
 * Returns comprehensive real-time analysis from all 3 agents
 * Designed for polling every 2-3 seconds by frontend
 * NOTE: This endpoint is expensive - consider moving to WebSocket/SSE for production
 */
router.get('/:sessionId', liveMonitoringLimiter, authenticate, checkSessionOwnership, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Run all 3 MCP Server C agents in parallel
    const [watcher, extractor, sanity] = await Promise.all([
      watchSession(sessionId, true, true),
      executeAnalysis(sessionId),
      flagSanityChecks(sessionId)
    ]);

    // Get session info for time calculations
    const session = await prisma.session.findUnique({
      where: { id: sessionId }
    });

    // Get all interactions for live metrics
    const interactions = await prisma.aiInteraction.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' }
    });

    const submissions = await prisma.submission.findMany({
      where: { sessionId },
      orderBy: { submittedAt: 'asc' }
    });

    // Calculate live metrics
    const liveMetrics = calculateLiveMetrics(interactions, submissions, session);

    // Build activity timeline (last 50 events)
    const timeline = buildActivityTimeline(interactions, submissions);

    // Get latest activity (last 5 events for "just now" display)
    const latestActivity = timeline.slice(0, 5);

    // Compile live report
    const liveReport = {
      timestamp: new Date().toISOString(),
      sessionId,
      
      // All 3 agents' analysis
      watcher: {
        violations: watcher.success ? watcher.violations : [],
        riskScore: watcher.success ? watcher.riskScore : 0,
        latestActivity: detectLatestActivity(interactions),
        status: session?.status || 'unknown'
      },
      
      extractor: {
        analysis: extractor.success ? extractor : null,
        overallScore: extractor.success ? extractor.behaviorScore : 100,
        promptQuality: calculatePromptQuality(interactions),
        selfReliance: calculateSelfReliance(interactions, submissions),
        codeIntegration: extractor.success ? extractor.codeIntegration : null
      },
      
      sanity: {
        violations: sanity.success ? sanity.violations : [],
        riskScore: sanity.success ? sanity.riskScore : 0,
        redFlags: sanity.success ? sanity.redFlags : [],
        overallRisk: sanity.success ? (sanity.riskScore && sanity.riskScore > 70 ? 'high' : sanity.riskScore && sanity.riskScore > 40 ? 'medium' : 'low') : 'low',
        recommendation: sanity.success ? (sanity.riskScore && sanity.riskScore > 70 ? 'Review session immediately' : sanity.riskScore && sanity.riskScore > 40 ? 'Monitor closely' : 'No concerns') : 'No concerns'
      },

      // Live metrics
      metrics: liveMetrics,
      
      // Activity timeline
      timeline,
      latestActivity,
      
      // Alerts
      alerts: generateAlerts(watcher, sanity, latestActivity)
    };

    res.json({
      success: true,
      data: liveReport
    });

  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper: Calculate live metrics
function calculateLiveMetrics(interactions: any[], submissions: any[], session: any) {
  const now = new Date();
  const sessionStart = session?.startedAt ? new Date(session.startedAt) : now;
  const timeElapsed = Math.floor((now.getTime() - sessionStart.getTime()) / 1000); // seconds

  const prompts = interactions.filter(i => i.eventType === 'prompt_sent');
  const responses = interactions.filter(i => i.eventType === 'response_received');
  const copies = interactions.filter(i => i.eventType === 'code_copied_from_ai');
  const pastes = interactions.filter(i => i.eventType === 'code_pasted_from_ai');
  const modifications = interactions.filter(i => i.eventType === 'code_modified');
  
  // WebContainer events
  const fileOperations = interactions.filter(i => 
    ['file_created', 'file_modified', 'file_deleted', 'file_renamed'].includes(i.eventType)
  );
  const terminalEvents = interactions.filter(i => 
    ['terminal_spawned', 'command_executed'].includes(i.eventType)
  );

  // Calculate AI time (rough estimate)
  let totalAITime = 0;
  prompts.forEach(prompt => {
    const response = responses.find(r => {
      const timeDiff = new Date(r.timestamp).getTime() - new Date(prompt.timestamp).getTime();
      return timeDiff > 0 && timeDiff < 60000; // Within 1 minute
    });
    if (response) {
      const timeDiff = new Date(response.timestamp).getTime() - new Date(prompt.timestamp).getTime();
      totalAITime += timeDiff;
    }
  });
  const aiTimePercent = timeElapsed > 0 ? Math.min(100, (totalAITime / 1000) / timeElapsed * 100) : 0;

  // Calculate copied lines
  const totalCopiedLines = copies.reduce((sum, copy: any) => {
    const lines = (copy.codeSnippet || '').split('\n').length;
    return sum + lines;
  }, 0);

  return {
    timeElapsed: formatTime(timeElapsed),
    timeElapsedSeconds: timeElapsed,
    totalPrompts: prompts.length,
    totalResponses: responses.length,
    totalCopies: copies.length,
    totalPastes: pastes.length,
    totalModifications: modifications.length,
    totalCopiedLines,
    aiTimePercent: Math.round(aiTimePercent),
    independentTimePercent: Math.round(100 - aiTimePercent),
    totalSubmissions: submissions.length,
    promptFrequency: timeElapsed > 0 ? (prompts.length / (timeElapsed / 60)).toFixed(1) : '0',
    // WebContainer metrics
    totalFileOperations: fileOperations.length,
    fileCreates: fileOperations.filter(f => f.eventType === 'file_created').length,
    fileModifies: fileOperations.filter(f => f.eventType === 'file_modified').length,
    fileDeletes: fileOperations.filter(f => f.eventType === 'file_deleted').length,
    fileRenames: fileOperations.filter(f => f.eventType === 'file_renamed').length,
    totalTerminalEvents: terminalEvents.length,
    terminalsSpawned: terminalEvents.filter(t => t.eventType === 'terminal_spawned').length,
    commandsExecuted: terminalEvents.filter(t => t.eventType === 'command_executed').length
  };
}

// Helper: Build activity timeline
function buildActivityTimeline(interactions: any[], submissions: any[]): any[] {
  const events: any[] = [];

  // Add all interactions
  interactions.forEach(i => {
    events.push({
      timestamp: i.timestamp,
      type: i.eventType,
      displayType: getDisplayType(i.eventType),
      emoji: getEmoji(i.eventType),
      description: getDescription(i),
      severity: getSeverity(i.eventType, i)
    });
  });

  // Add submissions
  submissions.forEach(s => {
    events.push({
      timestamp: s.submittedAt,
      type: 'submission',
      displayType: 'submission',
      emoji: '📤',
      description: 'Code submitted',
      severity: 'neutral'
    });
  });

  // Sort by timestamp (newest first)
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return events.slice(0, 50); // Last 50 events
}

// Helper: Detect latest activity
function detectLatestActivity(interactions: any[]): string {
  const recent = interactions.slice(-1)[0];
  if (!recent) return 'No activity yet';

  const now = new Date();
  const timeDiff = (now.getTime() - new Date(recent.timestamp).getTime()) / 1000;

  if (timeDiff < 5) return 'Just now - typing...';
  if (timeDiff < 15) return 'Just now - recent activity';
  if (timeDiff < 60) return `${Math.floor(timeDiff)}s ago`;
  return `${Math.floor(timeDiff / 60)}m ago`;
}

// Helper: Calculate prompt quality score
function calculatePromptQuality(interactions: any[]): number {
  const prompts = interactions.filter(i => i.eventType === 'prompt_sent');
  if (prompts.length === 0) return 100;

  let qualityScore = 100;
  prompts.forEach((prompt: any) => {
    if (prompt.promptText) {
      const text = prompt.promptText.toLowerCase();
      if (/solve.*entire|complete.*solution|write.*whole|do.*this.*for.*me/.test(text)) {
        qualityScore -= 15;
      } else if (/explain|how.*work|what.*is/.test(text)) {
        qualityScore += 2;
      } else if (text.length > 100) {
        qualityScore += 1;
      }
    }
  });

  return Math.max(0, Math.min(100, qualityScore / prompts.length));
}

// Helper: Calculate self-reliance score
function calculateSelfReliance(interactions: any[], submissions: any[]): number {
  let score = 100;
  const totalPrompts = interactions.filter(i => i.eventType === 'prompt_sent').length;
  
  // Deduct for excessive prompting
  if (totalPrompts > 30) score -= 30;
  else if (totalPrompts > 20) score -= 20;
  else if (totalPrompts > 10) score -= 10;

  // Check for solution requests
  const solutionRequests = interactions.filter((i: any) => {
    if (i.eventType === 'prompt_sent' && i.promptText) {
      return /solve|complete|write.*for.*me|give.*answer/.test(i.promptText.toLowerCase());
    }
    return false;
  }).length;

  score -= solutionRequests * 10;

  return Math.max(0, score);
}

// Helper: Generate alerts
function generateAlerts(watcher: any, sanity: any, latestActivity: any[]): any[] {
  const alerts: any[] = [];

  // High severity violations
  const highSeverity = [...(watcher.success ? watcher.violations : []), ...(sanity.success ? sanity.violations : [])]
    .filter((v: any) => v.severity === 'high')
    .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 3);

  highSeverity.forEach((v: any) => {
    alerts.push({
      type: 'high',
      severity: 'high',
      message: v.description,
      timestamp: v.timestamp,
      source: 'violation'
    });
  });

  // Check for recent large copies
  const recentCopies = latestActivity.filter(e => e.type === 'code_copied_from_ai');
  recentCopies.forEach(copy => {
    // This would need codeSnippet field - placeholder for now
    if (copy.timestamp) {
      alerts.push({
        type: 'medium',
        severity: 'medium',
        message: 'Recent code copy detected',
        timestamp: copy.timestamp,
        source: 'activity'
      });
    }
  });

  return alerts;
}

// Helper functions for timeline
function getDisplayType(eventType: string): string {
  const map: any = {
    'prompt_sent': 'prompt',
    'response_received': 'response',
    'code_copied_from_ai': 'copy',
    'code_pasted_from_ai': 'paste',
    'code_modified': 'edit',
    'submission': 'submission',
    // WebContainer events
    'file_created': 'file_create',
    'file_modified': 'file_edit',
    'file_deleted': 'file_delete',
    'file_renamed': 'file_rename',
    'terminal_spawned': 'terminal',
    'command_executed': 'command'
  };
  return map[eventType] || eventType;
}

function getEmoji(eventType: string): string {
  const map: any = {
    'prompt_sent': '💬',
    'response_received': '🤖',
    'code_copied_from_ai': '📋',
    'code_pasted_from_ai': '📋',
    'code_modified': '✓',
    'submission': '📤',
    // WebContainer events
    'file_created': '📄',
    'file_modified': '✏️',
    'file_deleted': '🗑️',
    'file_renamed': '📝',
    'terminal_spawned': '💻',
    'command_executed': '⚡'
  };
  return map[eventType] || '•';
}

function getDescription(interaction: any): string {
  const metadata = interaction.metadata || {};
  
  switch (interaction.eventType) {
    case 'prompt_sent':
      return interaction.promptText ? 
        `Asked: ${interaction.promptText.substring(0, 50)}${interaction.promptText.length > 50 ? '...' : ''}` :
        'Sent prompt';
    case 'response_received':
      return 'Received AI response';
    case 'code_copied_from_ai':
      const lines = (interaction.codeSnippet || '').split('\n').length;
      return `Copied code (${lines} lines)`;
    case 'code_pasted_from_ai':
      return 'Pasted code into editor';
    case 'code_modified':
      return 'Modified code';
    // WebContainer events
    case 'file_created':
      return `Created ${metadata.isDirectory ? 'folder' : 'file'}: ${metadata.fileName || metadata.filePath || 'unknown'}`;
    case 'file_modified':
      return `Modified: ${metadata.filePath || 'file'}`;
    case 'file_deleted':
      return `Deleted ${metadata.isDirectory ? 'folder' : 'file'}: ${metadata.filePath || 'unknown'}`;
    case 'file_renamed':
      return `Renamed: ${metadata.newName || metadata.filePath || 'file'}`;
    case 'terminal_spawned':
      return `New terminal: ${metadata.terminalName || 'Terminal'}`;
    case 'command_executed':
      return `Ran: ${metadata.command || 'command'}`;
    default:
      return interaction.eventType;
  }
}

function getSeverity(eventType: string, interaction: any): string {
  if (eventType === 'prompt_sent' && interaction.promptText) {
    const text = interaction.promptText.toLowerCase();
    if (/solve.*entire|complete.*solution|write.*whole/.test(text)) {
      return 'high';
    }
  }
  return 'neutral';
}

function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export default router;

