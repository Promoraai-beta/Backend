/**
 * Docs Tool
 *
 * Activates when the recruiter selected the 'docs' component.
 *
 * The critical difference from the old approach: the Google Doc prompt is
 * derived from the ACTUAL scenario Server B generated — real model names,
 * real route paths, real intentional issues — not a generic description
 * from Server A that was written before the codebase existed.
 *
 * This is the no-disconnection guarantee for docs.
 */

import { logger }          from '../lib/logger';
import type { AssessmentTool, ScenarioContext, ToolContent, ToolProvisionResult } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferDomain(ctx: ScenarioContext): string {
  // Try to extract domain from README.md in the fileStructure
  const readme = ctx.fileStructure['README.md'] ?? '';
  const firstLine = readme.split('\n').find(l => l.trim().startsWith('#'))?.replace('#', '').trim();
  if (firstLine) return firstLine;

  // Fall back to job role + company
  if (ctx.companyName) return `${ctx.companyName} — ${ctx.jobRole}`;
  return ctx.jobRole || 'Engineering';
}

function extractKeyComponents(fileStructure: Record<string, string>): string[] {
  // Pull out the most domain-specific file names (not generic infra files)
  const skip = new Set([
    'frontend/index.html', 'frontend/vite.config.ts', 'frontend/tsconfig.json',
    'frontend/tsconfig.node.json', 'frontend/src/test/setup.ts',
    'backend/__init__.py', 'backend/auth.py', 'backend/conftest.py',
    '.env', 'README.md',
  ]);
  return Object.keys(fileStructure)
    .filter(f => !skip.has(f) && (f.includes('components/') || f.includes('routes/') || f.includes('services/')))
    .slice(0, 6);  // top 6 most relevant files
}

function buildDocPrompt(ctx: ScenarioContext): { title: string; description: string } {
  const domain = inferDomain(ctx);
  const keyFiles = extractKeyComponents(ctx.fileStructure);

  // Build the doc prompt from the ACTUAL bugs in this scenario
  const bugLines = ctx.intentionalIssues.map((issue, i) =>
    `${i + 1}. ${issue.description}${issue.file ? ` (${issue.file})` : ''}`
  ).join('\n');

  const fileList = keyFiles.length > 0
    ? `Key files: ${keyFiles.map(f => `\`${f}\``).join(', ')}.`
    : '';

  const title = `${domain} — Engineering Runbook`;

  const description =
    `Write a technical runbook for the ${domain} system.\n\n` +
    `${fileList}\n\n` +
    `Your runbook must address the following known issues in this codebase:\n${bugLines}\n\n` +
    `For each issue, document:\n` +
    `- What the bug is and why it matters\n` +
    `- How to reproduce it\n` +
    `- The correct fix with code snippets\n` +
    `- How to verify the fix works\n\n` +
    `Also include a "Getting Started" section with commands to run the project locally.`;

  return { title, description };
}

// ── Google Doc provisioning ───────────────────────────────────────────────────

async function createGoogleDoc(
  sessionId: string,
  title: string,
  description: string,
): Promise<string | null> {
  try {
    const { getOAuthAccessToken } = await import('../services/google-auth');
    const accessToken = await getOAuthAccessToken();
    const parentFolderId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;

    const docBody: Record<string, any> = {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
    };
    if (parentFolderId) docBody.parents = [parentFolderId];

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(docBody),
    });
    if (!createRes.ok) {
      logger.warn(`[DocsTool] Drive create failed (${createRes.status})`);
      return null;
    }
    const doc = await createRes.json() as any;
    const docId = doc.id;

    // Anyone with link can edit
    await fetch(`https://www.googleapis.com/drive/v3/files/${docId}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ role: 'writer', type: 'anyone' }),
    });

    // Pre-fill with the scenario-derived prompt
    if (description) {
      await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          requests: [{
            insertText: {
              location: { index: 1 },
              text: `${title}\n\n${description}\n\n---\n\nYour answer:\n\n`,
            },
          }],
        }),
      });
    }

    // Save URL to session tool_resources
    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
    const { prisma } = await import('../lib/prisma');
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { toolResources: true },
    });
    const existing = (session?.toolResources as any) ?? {};
    await prisma.session.update({
      where: { id: sessionId },
      data: { toolResources: { ...existing, docs: { url: docUrl, docId } } },
    });

    logger.info(`[DocsTool] Google Doc created: ${docUrl}`);
    return docUrl;
  } catch (err: any) {
    logger.error(`[DocsTool] Failed to create Google Doc: ${err.message}`);
    return null;
  }
}

// ── Tool implementation ───────────────────────────────────────────────────────

export const docsTool: AssessmentTool = {
  id:      'docs',
  label:   'Docs',
  metaKey: 'hasDocs',

  detect(ctx: ScenarioContext): boolean {
    return ctx.components.includes('docs');
  },

  generateContent(ctx: ScenarioContext): ToolContent {
    // Derive the doc prompt entirely from the scenario context —
    // real domain, real files, real bugs. No generic Server A descriptions.
    const { title, description } = buildDocPrompt(ctx);
    return {
      toolId: 'docs',
      payload: { title, description },
    };
  },

  async provisionAsync(
    sessionId:   string,
    _sessionCode: string,
    content:     ToolContent,
  ): Promise<ToolProvisionResult> {
    const { title, description } = content.payload;
    const url = await createGoogleDoc(sessionId, title, description);
    return { toolId: 'docs', url: url ?? undefined };
  },

  enrichResponse(
    response:        Record<string, any>,
    content:         ToolContent,
    provisionResult?: ToolProvisionResult,
  ): void {
    if (!response.assessmentMeta) response.assessmentMeta = {};
    response.assessmentMeta.hasDocs = true;
    if (provisionResult?.url) {
      response.docsFileUrl = provisionResult.url;
    }
  },
};
