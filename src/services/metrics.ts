/**
 * Session metrics computed from AI interactions and submissions.
 * Used by full-report and live-monitoring.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────
function eventType(i: any): string { return i.eventType || i.event_type || ''; }
function promptText(i: any): string { return (i.promptText || i.prompt_text || '').toLowerCase(); }
function modelName(i: any): string  { return i.model || 'unknown'; }

// ── Prompt quality 0-100 ──────────────────────────────────────────────────────
/**
 * Higher = better prompts (clarifying, exploratory, specific).
 * Fixed: score is accumulated as a running average, NOT divided by count at the end.
 */
export function calculatePromptQuality(interactions: any[]): number {
  const prompts = interactions.filter(i => eventType(i) === 'prompt_sent');
  if (prompts.length === 0) return 100;

  let totalDelta = 0;

  prompts.forEach((prompt: any) => {
    const text = promptText(prompt);
    if (!text) return;

    // Negative signals
    if (/solve.*entire|complete.*solution|write.*whole|do.*this.*for.*me/.test(text)) totalDelta -= 15;
    if (/give.*me.*the.*answer|just.*tell.*me|cheat/.test(text)) totalDelta -= 10;

    // Positive signals
    if (/explain|how.*work|what.*is|help.*understand|why/.test(text)) totalDelta += 5;
    if (/i.*tried|i.*think|my.*approach|does.*this.*look/.test(text)) totalDelta += 5; // shows thinking
    if (text.length > 150) totalDelta += 2; // detailed prompt
  });

  // Volume penalty: excessive prompting suggests over-reliance
  if (prompts.length > 30) totalDelta -= 20;
  else if (prompts.length > 20) totalDelta -= 10;
  else if (prompts.length > 10) totalDelta -= 5;

  return Math.max(0, Math.min(100, Math.round(100 + totalDelta)));
}

// ── Self-reliance 0-100 ───────────────────────────────────────────────────────
export function calculateSelfReliance(interactions: any[], _submissions: any[]): number {
  let score = 100;
  const prompts = interactions.filter(i => eventType(i) === 'prompt_sent');

  if (prompts.length > 30) score -= 30;
  else if (prompts.length > 20) score -= 20;
  else if (prompts.length > 10) score -= 10;

  const solutionRequests = prompts.filter((i: any) =>
    /solve|complete|write.*for.*me|give.*answer|do.*this.*for.*me/.test(promptText(i))
  ).length;
  score -= solutionRequests * 10;

  const appliedCount = interactions.filter(i => eventType(i) === 'code_applied_from_ai').length;
  score -= appliedCount * 5;

  return Math.max(0, Math.min(100, score));
}

// ── Per-model token breakdown ─────────────────────────────────────────────────
export interface ModelUsage {
  model: string;
  promptCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

export function calculateModelBreakdown(interactions: any[]): ModelUsage[] {
  const map = new Map<string, { promptCount: number; promptTokens: number; completionTokens: number; latencies: number[] }>();

  interactions
    .filter(i => eventType(i) === 'response_received')
    .forEach(i => {
      const m = modelName(i);
      if (!map.has(m)) map.set(m, { promptCount: 0, promptTokens: 0, completionTokens: 0, latencies: [] });
      const entry = map.get(m)!;
      entry.promptCount += 1;
      entry.promptTokens += i.promptTokens || i.prompt_tokens || 0;
      entry.completionTokens += i.completionTokens || i.completion_tokens || 0;
      if (i.latencyMs || i.latency_ms) entry.latencies.push(i.latencyMs || i.latency_ms);
    });

  return Array.from(map.entries())
    .map(([model, d]) => ({
      model,
      promptCount: d.promptCount,
      promptTokens: d.promptTokens,
      completionTokens: d.completionTokens,
      totalTokens: d.promptTokens + d.completionTokens,
      avgLatencyMs: d.latencies.length ? Math.round(d.latencies.reduce((a, b) => a + b, 0) / d.latencies.length) : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

// ── Model switch count ────────────────────────────────────────────────────────
export function calculateModelSwitches(interactions: any[]): number {
  const responses = interactions
    .filter(i => eventType(i) === 'response_received')
    .sort((a, b) => new Date(a.timestamp || a.createdAt || 0).getTime() - new Date(b.timestamp || b.createdAt || 0).getTime());

  let switches = 0;
  for (let idx = 1; idx < responses.length; idx++) {
    if (modelName(responses[idx]) !== modelName(responses[idx - 1])) switches++;
  }
  return switches;
}

// ── Prompt IQ 0-100 (composite of quality + specificity + model choice) ───────
export function calculatePromptIQ(interactions: any[]): number {
  const quality = calculatePromptQuality(interactions);
  const switches = calculateModelSwitches(interactions);
  // Reward using different models strategically (up to 2 switches = good, more = chaotic)
  const switchBonus = Math.min(switches, 2) * 3;
  return Math.max(0, Math.min(100, Math.round(quality + switchBonus)));
}

// ── Main compute function ─────────────────────────────────────────────────────
export function computeSessionMetrics(interactions: any[], submissions: any[]): {
  promptQuality: number;
  selfReliance: number;
  promptIQ: number;
  promptCount: number;
  copyCount: number;
  applyCount: number;
  totalTokens: number;
  modelSwitches: number;
  modelBreakdown: ModelUsage[];
} {
  const promptCount   = interactions.filter(i => eventType(i) === 'prompt_sent').length;
  const copyCount     = interactions.filter(i => ['code_copied_from_ai', 'code_pasted_from_ai'].includes(eventType(i))).length;
  const applyCount    = interactions.filter(i => eventType(i) === 'code_applied_from_ai').length;
  const modelBreakdown = calculateModelBreakdown(interactions);
  const totalTokens   = modelBreakdown.reduce((sum, m) => sum + m.totalTokens, 0);

  return {
    promptQuality:  calculatePromptQuality(interactions),
    selfReliance:   calculateSelfReliance(interactions, submissions),
    promptIQ:       calculatePromptIQ(interactions),
    promptCount,
    copyCount,
    applyCount,
    totalTokens,
    modelSwitches:  calculateModelSwitches(interactions),
    modelBreakdown,
  };
}
