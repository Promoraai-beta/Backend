/**
 * Code Server Tool
 *
 * Activates when the scenario has a frontend/ or backend/ directory —
 * i.e. Server B generated a full-stack codebase.
 * The container is provisioned at INVITE time (not here), so this tool
 * only handles detection, content derivation, and response enrichment.
 */

import type { AssessmentTool, ScenarioContext, ToolContent, ToolProvisionResult } from './types';

export const codeServerTool: AssessmentTool = {
  id:      'code-server',
  label:   'Code Server',
  metaKey: 'hasCode',

  detect(ctx: ScenarioContext): boolean {
    // Active whenever there's a generated codebase
    const files = Object.keys(ctx.fileStructure);
    return (
      files.some(f => f.startsWith('frontend/') || f.startsWith('backend/')) ||
      ctx.components.includes('ide_project') ||
      ctx.components.includes('code')
    );
  },

  generateContent(ctx: ScenarioContext): ToolContent {
    // Extract the actual tech stack from the generated files
    const files = Object.keys(ctx.fileStructure);
    const hasFrontend = files.some(f => f.startsWith('frontend/'));
    const hasBackend  = files.some(f => f.startsWith('backend/'));
    const hasTests    = files.some(f => f.includes('.test.') || f.includes('__tests__'));

    // Build a summary of what's in the codebase for the AI assistant context
    const layers: string[] = [];
    if (hasFrontend) layers.push('React/TypeScript frontend');
    if (hasBackend)  layers.push('Flask/Python backend');
    if (hasTests)    layers.push('test suite (Vitest + pytest)');

    const bugSummary = ctx.intentionalIssues.map((issue, i) =>
      `${i + 1}. [${issue.severity ?? 'medium'}] ${issue.description} (${issue.file ?? 'unknown file'})`
    ).join('\n');

    return {
      toolId: 'code-server',
      payload: {
        layers,
        fileCount:   files.length,
        bugCount:    ctx.intentionalIssues.length,
        bugSummary,
        hasFrontend,
        hasBackend,
        hasTests,
      },
    };
  },

  // No provisionAsync — container is provisioned at invite time in sessions.ts
  // (provisionLocalContainer / provisionAssessmentContainer)

  enrichResponse(
    response: Record<string, any>,
    content:  ToolContent,
  ): void {
    if (!response.assessmentMeta) response.assessmentMeta = {};
    response.assessmentMeta.hasCode    = true;
    response.assessmentMeta.fileCount  = content.payload.fileCount;
    response.assessmentMeta.bugCount   = content.payload.bugCount;
    response.assessmentMeta.hasFrontend = content.payload.hasFrontend;
    response.assessmentMeta.hasBackend  = content.payload.hasBackend;
  },
};
