/**
 * tool-resources.ts
 *
 * Single source of truth for per-session tool URLs.
 * Stored as JSONB in sessions.tool_resources — one column covers every tool,
 * so adding a new tool integration never requires a schema migration.
 *
 * Shape:
 * {
 *   figma:  { url, viewUrl?, resourceId, provisionedAt, lockedAt? },
 *   sheets: { url, viewUrl, resourceId, provisionedAt, lockedAt? },
 *   docs:   { url, viewUrl, resourceId, provisionedAt, lockedAt? },
 *   ...
 * }
 */

import { PrismaClient } from '@prisma/client';

export interface ToolResource {
  url: string;           // Edit / working URL (for candidate)
  viewUrl?: string;      // Read-only URL (for recruiter)
  resourceId: string;    // Tool-specific ID for API calls (file ID, spreadsheet ID, etc.)
  provisionedAt: string; // ISO timestamp
  lockedAt?: string;     // ISO timestamp — set when session ends and file is locked
}

export type ToolResourceMap = Record<string, ToolResource>;

// ─── Read ─────────────────────────────────────────────────────────────────────

export function getToolResources(session: any): ToolResourceMap {
  const raw = session?.toolResources;

  // Base from new JSON column
  const resources: ToolResourceMap = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as ToolResourceMap)
    : {};

  // Back-compat: fold legacy individual columns in if JSON column is missing them
  if (!resources.figma && session?.figmaFileUrl) {
    resources.figma = {
      url: session.figmaFileUrl,
      resourceId: session.figmaResourceId || '',
      provisionedAt: session.createdAt?.toISOString?.() || new Date().toISOString(),
    };
  }
  if (!resources.sheets && session?.sheetsFileUrl) {
    resources.sheets = {
      url: session.sheetsFileUrl,
      viewUrl: session.sheetsFileUrl.replace(/\/edit.*$/, '/view'),
      resourceId: session.sheetsResourceId || '',
      provisionedAt: session.createdAt?.toISOString?.() || new Date().toISOString(),
    };
  }

  return resources;
}

export function getTool(session: any, toolId: string): ToolResource | null {
  return getToolResources(session)[toolId] ?? null;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Merge a single tool entry into the session's toolResources JSON.
 * Returns the Prisma `data` patch — pass it to prisma.session.update().
 */
export async function upsertToolResource(
  prisma: PrismaClient,
  sessionId: string,
  toolId: string,
  resource: ToolResource,
): Promise<void> {
  const session = await (prisma.session.findUnique as any)({
    where: { id: sessionId },
    select: { id: true, toolResources: true },
  });

  const raw = (session as any)?.toolResources;
  const current: ToolResourceMap = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as unknown as ToolResourceMap)
    : {};

  const updated: ToolResourceMap = { ...current, [toolId]: resource };

  await (prisma.session.update as any)({
    where: { id: sessionId },
    data: { toolResources: updated },
  });
}

/**
 * Mark a tool as locked (read-only) by setting lockedAt timestamp.
 */
export async function markToolLocked(
  prisma: PrismaClient,
  sessionId: string,
  toolId: string,
): Promise<void> {
  const session = await (prisma.session.findUnique as any)({
    where: { id: sessionId },
    select: { id: true, toolResources: true },
  });

  const raw2 = (session as any)?.toolResources;
  const current: ToolResourceMap = (raw2 && typeof raw2 === 'object' && !Array.isArray(raw2))
    ? (raw2 as unknown as ToolResourceMap)
    : {};

  if (!current[toolId]) return; // Nothing to mark

  const updated: ToolResourceMap = {
    ...current,
    [toolId]: { ...current[toolId], lockedAt: new Date().toISOString() },
  };

  await (prisma.session.update as any)({
    where: { id: sessionId },
    data: { toolResources: updated },
  });
}
