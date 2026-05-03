/**
 * Figma Plugin - Backend (provision + evaluate)
 */

import type { Plugin, PluginManifest, PluginProvisionResult, PluginEvaluation } from "../plugin-registry";

interface FigmaFileResponse {
  file?: { key?: string };
  document?: any;
  lastModified?: string;
}

const manifest: PluginManifest = {
  id: "figma",
  name: "Figma",
  version: "1.0.0",
  description: "Design assessment via Figma",
  icon: "🎨",
  category: "design",
  credentials_required: ["FIGMA_ACCESS_TOKEN"],
  assessment_types: ["frontend", "designer", "product_manager"],
  provision_type: "creates_resource",
  ui: { label: "Open Figma", opens_in: "new_tab" }
};

async function provision(
  sessionId: string,
  config: { templateId?: string; figmaTemplateId?: string; credentials: Record<string, string> }
): Promise<PluginProvisionResult> {
  const templateId = config.templateId || config.figmaTemplateId;
  const token = config.credentials?.FIGMA_ACCESS_TOKEN;
  if (!templateId || !token) throw new Error("Figma: templateId and FIGMA_ACCESS_TOKEN required");

  const res = await fetch(`https://api.figma.com/v1/files/${templateId}`, {
    headers: { "X-Figma-Token": token }
  });
  if (!res.ok) throw new Error(`Figma API: ${res.status} ${await res.text()}`);

  const file = (await res.json()) as FigmaFileResponse;
  const fileKey = file.file?.key || templateId;

  return {
    url: `https://www.figma.com/file/${fileKey}?node-id=0%3A1`,
    resourceId: fileKey
  };
}

async function analyze(
  resourceId: string,
  credentials: Record<string, string>
): Promise<{ insights: any }> {
  const token = credentials?.FIGMA_ACCESS_TOKEN;
  if (!token) throw new Error("FIGMA_ACCESS_TOKEN required");

  try {
    const res = await fetch(`https://api.figma.com/v1/files/${resourceId}`, {
      headers: { "X-Figma-Token": token }
    });
    if (!res.ok) throw new Error(`Figma API: ${res.status}`);

    const file = (await res.json()) as FigmaFileResponse;
    const doc = file.document;

    return {
      insights: {
        components_used: countNodes(doc, "INSTANCE"),
        frames_created: countNodes(doc, "FRAME"),
        layers_total: countAllNodes(doc),
        uses_design_system: countNodes(doc, "INSTANCE") > 0,
        last_modified: file.lastModified
      }
    };
  } catch (err: any) {
    return {
      insights: {
        error: err.message,
        components_used: 0,
        frames_created: 0,
        layers_total: 0,
        uses_design_system: false
      }
    };
  }
}

async function evaluate(
  resourceId: string,
  allInsights: Array<{ source: string; payload: any }>,
  credentials: Record<string, string>
): Promise<PluginEvaluation> {
  const snapshots = allInsights.filter(i => i.source === "figma");
  const latest = snapshots[snapshots.length - 1]?.payload;

  if (!latest || latest.error) {
    return { score: 0, notes: latest?.error || "No design activity", strengths: [], gaps: [] };
  }

  let score = 5;
  if (latest.uses_design_system) score += 2;
  if (latest.frames_created > 3) score += 1;
  if (latest.components_used > 5) score += 1;
  if (latest.layers_total > 20) score += 1;
  score = Math.min(score, 10);

  const parts: string[] = [];
  if (latest.uses_design_system) parts.push("Used design system");
  if (latest.frames_created > 0) parts.push(`${latest.frames_created} frames`);
  if (latest.components_used > 0) parts.push(`${latest.components_used} components`);

  return {
    score,
    notes: parts.join(". ") || "Minimal design activity",
    strengths: latest.uses_design_system ? ["Design system usage"] : [],
    gaps: !latest.uses_design_system ? ["Could use design system"] : []
  };
}

function countNodes(node: any, type: string, n = 0): number {
  if (!node) return n;
  if (node.type === type) n++;
  if (node.children) node.children.forEach((c: any) => { n = countNodes(c, type, n); });
  return n;
}

function countAllNodes(node: any, n = 0): number {
  if (!node) return n;
  n++;
  if (node.children) node.children.forEach((c: any) => { n = countAllNodes(c, n); });
  return n;
}

const plugin: Plugin = {
  id: manifest.id,
  name: manifest.name,
  manifest,
  provision,
  analyze,
  evaluate
};

export default plugin;
