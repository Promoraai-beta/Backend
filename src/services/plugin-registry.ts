/**
 * Backend Plugin Registry - Figma only for now
 */

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  category: string;
  credentials_required: string[];
  assessment_types: string[];
  provision_type: string;
  ui: { label: string; opens_in: string };
}

export interface PluginProvisionResult {
  url: string;
  resourceId: string;
}

export interface PluginEvaluation {
  score: number;
  notes: string;
  strengths: string[];
  gaps: string[];
}

export interface Plugin {
  id: string;
  name: string;
  manifest: PluginManifest;
  provision: (sessionId: string, config: any) => Promise<PluginProvisionResult>;
  analyze: (resourceId: string, credentials: Record<string, string>) => Promise<{ insights: any }>;
  evaluate: (resourceId: string, allInsights: any[], credentials: Record<string, string>) => Promise<PluginEvaluation>;
}

const plugins: Map<string, Plugin> = new Map();

import figmaPlugin from "./plugins/figma";
import sheetsPlugin from "./plugins/sheets";
plugins.set("figma", figmaPlugin);
plugins.set("sheets", sheetsPlugin);

export function getPlugin(id: string): Plugin | undefined {
  return plugins.get(id);
}

export function getActivePlugins(activeTools: string[]): Plugin[] {
  return activeTools.map(id => plugins.get(id)).filter((p): p is Plugin => !!p);
}

export function listPlugins(): Array<{ id: string; name: string; icon: string; category: string }> {
  return Array.from(plugins.values()).map(p => ({
    id: p.id,
    name: p.name,
    icon: p.manifest.icon,
    category: p.manifest.category
  }));
}
