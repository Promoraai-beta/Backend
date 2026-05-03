/**
 * Tool Registry
 *
 * Central registry for all assessment tools. Each tool registers itself here.
 * sessions.ts calls activateTools() instead of hand-rolling hasDatabase/hasDocs checks.
 *
 * To add a new tool:
 *   1. Create src/tools/my-tool.tool.ts implementing AssessmentTool
 *   2. Import it here and add to TOOLS array
 *   3. Done — sessions.ts picks it up automatically
 */

import { logger } from '../lib/logger';
import type { AssessmentTool, ScenarioContext, ToolContent, ToolProvisionResult } from './types';

// ── Tool registrations ────────────────────────────────────────────────────────
import { codeServerTool }  from './code-server.tool';
import { databaseTool }    from './database.tool';
import { docsTool }        from './docs.tool';
import { sheetsTool }      from './sheets.tool';

const TOOLS: AssessmentTool[] = [
  codeServerTool,
  databaseTool,
  docsTool,
  sheetsTool,
  // Add new tools here — nothing else changes
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the subset of tools that are active for this scenario.
 * A tool is active when its detect() returns true.
 */
export function getActiveTools(ctx: ScenarioContext): AssessmentTool[] {
  return TOOLS.filter(tool => {
    try {
      return tool.detect(ctx);
    } catch (err: any) {
      logger.warn(`[ToolRegistry] detect() error for tool "${tool.id}": ${err.message}`);
      return false;
    }
  });
}

/**
 * Build ScenarioContext from raw session/assessment/template data.
 * This is the single place where Server B's output is packaged into the
 * context that every tool reads from — the no-disconnection guarantee.
 */
export function buildScenarioContext(params: {
  fileStructure:     Record<string, string>;
  intentionalIssues: any[];
  jobRole:           string;
  techStack:         string[];
  jobDescription:    string;
  companyName:       string;
  level:             string;
  recruiterTasks:    any[];
  derivedTasks:      any[];
  components:        string[];
}): ScenarioContext {
  return {
    fileStructure:     params.fileStructure      ?? {},
    intentionalIssues: params.intentionalIssues  ?? [],
    jobRole:           params.jobRole            || 'Engineer',
    techStack:         params.techStack          ?? [],
    jobDescription:    params.jobDescription     || '',
    companyName:       params.companyName        || '',
    level:             params.level              || 'Mid-level',
    recruiterTasks:    params.recruiterTasks     ?? [],
    derivedTasks:      params.derivedTasks       ?? [],
    components:        params.components         ?? [],
  };
}

/**
 * Run all active tools for a session:
 *   1. generateContent() — synchronous, derives content from scenario
 *   2. provisionAsync()  — async, creates external resources (fire-and-forget)
 *   3. enrichResponse()  — adds flags/URLs to the API response
 *
 * Returns the enriched response object.
 */
export async function activateTools(
  sessionId:   string,
  sessionCode: string,
  ctx:         ScenarioContext,
  response:    Record<string, any>,
  options: { fireAndForget?: boolean } = { fireAndForget: true },
): Promise<Record<string, any>> {
  const activeTools = getActiveTools(ctx);

  logger.info(
    `[ToolRegistry] Active tools for session ${sessionCode}: ` +
    activeTools.map(t => t.id).join(', ')
  );

  // Generate content synchronously for all tools — fast, no I/O
  const contents = new Map<string, ToolContent>();
  for (const tool of activeTools) {
    try {
      contents.set(tool.id, tool.generateContent(ctx));
    } catch (err: any) {
      logger.warn(`[ToolRegistry] generateContent() error for "${tool.id}": ${err.message}`);
    }
  }

  // Provision external resources
  const provisionResults = new Map<string, ToolProvisionResult>();

  const toolsNeedingProvision = activeTools.filter(t => t.provisionAsync);

  if (options.fireAndForget) {
    // Fire all async provisions in background — session start stays fast
    setImmediate(async () => {
      for (const tool of toolsNeedingProvision) {
        const content = contents.get(tool.id);
        if (!content) continue;
        try {
          const result = await tool.provisionAsync!(sessionId, sessionCode, content);
          logger.info(`[ToolRegistry] ${tool.id} provisioned: ${result.url ?? 'no url'}`);
        } catch (err: any) {
          logger.error(`[ToolRegistry] ${tool.id} provision failed: ${err.message}`);
        }
      }
    });
  } else {
    // Await all provisions (used when caller needs the URLs synchronously)
    await Promise.allSettled(
      toolsNeedingProvision.map(async tool => {
        const content = contents.get(tool.id);
        if (!content) return;
        try {
          const result = await tool.provisionAsync!(sessionId, sessionCode, content);
          provisionResults.set(tool.id, result);
        } catch (err: any) {
          logger.error(`[ToolRegistry] ${tool.id} provision failed: ${err.message}`);
        }
      })
    );
  }

  // Enrich the response with all active tools' flags and URLs
  for (const tool of activeTools) {
    const content = contents.get(tool.id);
    if (!content) continue;
    try {
      tool.enrichResponse(response, content, provisionResults.get(tool.id));
    } catch (err: any) {
      logger.warn(`[ToolRegistry] enrichResponse() error for "${tool.id}": ${err.message}`);
    }
  }

  return response;
}
