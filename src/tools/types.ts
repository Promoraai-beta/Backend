/**
 * Tool Registry — type definitions
 *
 * Every assessment component (code server, database, docs, figma, …) is an
 * AssessmentTool. All tools share the same ScenarioContext so they always
 * describe the same system — no disconnection between tabs.
 *
 * Adding a new tool = implement AssessmentTool, register in registry.ts.
 * Nothing else in sessions.ts needs to change.
 */

// ── Scenario context ──────────────────────────────────────────────────────────
// Produced once from Server B's output and passed to every tool unchanged.
// This is the single wire that keeps all tools connected to the same scenario.

export interface IntentionalIssue {
  id: string;
  description: string;
  file?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  category?: string;
  line_hint?: string;
}

export interface ScenarioContext {
  // Core scenario — from Server B
  fileStructure:      Record<string, string>;
  intentionalIssues:  IntentionalIssue[];

  // Job context — from the assessment record
  jobRole:        string;
  techStack:      string[];
  jobDescription: string;
  companyName:    string;
  level:          string;

  // Recruiter's original tasks (from Server A) — for fallback / enrichment
  recruiterTasks: any[];

  // Derived tasks stored in the session template (from intentionalIssues)
  derivedTasks: any[];

  // Which component types the recruiter selected when creating the assessment
  // e.g. ['ide_project', 'database', 'docs']
  components: string[];
}

// ── Per-tool content ──────────────────────────────────────────────────────────
// What a tool generates from the ScenarioContext before provisioning.
// Kept generic so each tool can carry whatever payload it needs.

export interface ToolContent {
  toolId:  string;
  payload: Record<string, any>;
}

// ── Provision result ──────────────────────────────────────────────────────────
// What a tool returns after provisioning its external resource.

export interface ToolProvisionResult {
  toolId:   string;
  url?:     string;                    // primary access URL for this tool
  metadata?: Record<string, any>;      // any extra data to store / surface
}

// ── The tool interface ────────────────────────────────────────────────────────

export interface AssessmentTool {
  /** Stable identifier — matches component names used by recruiters */
  id: string;

  /** Human-readable label shown in logs */
  label: string;

  /**
   * The key set on `assessmentMeta` when this tool is active.
   * e.g. 'hasDatabase', 'hasDocs', 'hasCode'
   * The frontend reads these flags to decide which tabs to render.
   */
  metaKey: string;

  /**
   * Detect whether this tool should activate for a given scenario.
   * Called at session-start time. Return true to activate.
   */
  detect(ctx: ScenarioContext): boolean;

  /**
   * Derive this tool's content from the scenario context.
   * Must reference the actual domain models / files / issues — no independent
   * content generation. This is the no-disconnection guarantee.
   *
   * Synchronous — runs inline during session start.
   */
  generateContent(ctx: ScenarioContext): ToolContent;

  /**
   * Provision the external resource for this tool (container, Google Doc, etc.).
   * May be called fire-and-forget for slow operations.
   *
   * Optional — tools that don't need an external resource omit this.
   */
  provisionAsync?(
    sessionId:   string,
    sessionCode: string,
    content:     ToolContent,
  ): Promise<ToolProvisionResult>;

  /**
   * Enrich the session-start API response with this tool's flags and URLs.
   * Called after provisionAsync resolves (or immediately if no provision needed).
   */
  enrichResponse(
    response:      Record<string, any>,
    content:       ToolContent,
    provisionResult?: ToolProvisionResult,
  ): void;
}
