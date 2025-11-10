/**
 * Shared types for MCP integration
 */

export interface TemplateSpec {
  name: string;
  runtime: string;
  packageManager: "npm" | "yarn" | "pip" | "maven" | "go";
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts: Record<string, string>;
  fileStructure: Record<string, string>;
}

