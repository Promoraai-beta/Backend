/**
 * Sheets Tool
 *
 * Activates when the recruiter selected the 'sheets' component OR the template
 * already has a sheetsTemplateId / sheetsFileKey.
 *
 * Unlike the docs tool, the Google Sheet is provisioned by copying a master
 * template spreadsheet at invite time (via /provision-sheets).  This tool
 * only handles detection, content derivation, and response enrichment —
 * no provisionAsync needed here.
 */

import type { AssessmentTool, ScenarioContext, ToolContent } from './types';

export const sheetsTool: AssessmentTool = {
  id:      'sheets',
  label:   'Sheets',
  metaKey: 'hasSheets',

  detect(ctx: ScenarioContext): boolean {
    if (ctx.components.includes('sheets')) return true;

    // Also detect from fileStructure keys that suggest a spreadsheet scenario
    const files = Object.keys(ctx.fileStructure);
    return files.some(f => f.endsWith('.csv') || f.includes('spreadsheet'));
  },

  generateContent(ctx: ScenarioContext): ToolContent {
    // Find the sheets-related task if one exists
    const sheetsTask = ctx.recruiterTasks.find((t: any) => {
      const title = (t.title || t.type || '').toLowerCase();
      const comps  = (t.components || []).map((c: any) => String(c).toLowerCase());
      return title.includes('sheet') || title.includes('spreadsheet') || comps.includes('sheets');
    }) ?? null;

    // Find any issues that reference data/spreadsheet work
    const sheetsIssues = ctx.intentionalIssues.filter(issue =>
      issue.category === 'data_layer' ||
      (issue.file && (issue.file.endsWith('.csv') || issue.file.includes('sheet')))
    );

    const taskDescription = sheetsTask?.description
      ?? (sheetsIssues.length > 0
        ? sheetsIssues.map(i => i.description).join('\n')
        : `Inspect and correct the spreadsheet data for the ${ctx.jobRole} assessment.`);

    return {
      toolId: 'sheets',
      payload: {
        taskTitle:       sheetsTask?.title ?? 'Spreadsheet Task',
        taskDescription,
        sheetsIssueCount: sheetsIssues.length,
      },
    };
  },

  // No provisionAsync — the sheet copy is triggered by the frontend's
  // /api/sessions/:id/provision-sheets endpoint at first access.

  enrichResponse(
    response: Record<string, any>,
    content:  ToolContent,
  ): void {
    if (!response.assessmentMeta) response.assessmentMeta = {};
    response.assessmentMeta.hasSheets = true;
    // sheetsTemplateId / sheetsFileUrl are populated from the template by sessions.ts — not here
  },
};
