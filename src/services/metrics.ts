/**
 * Session metrics computed from AI interactions and submissions.
 * Used by full-report and live-monitoring.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────
function eventType(i: any): string { return i.eventType || i.event_type || ''; }
function promptText(i: any): string { return (i.promptText || i.prompt_text || '').toLowerCase(); }
function modelName(i: any): string  { return i.model || 'unknown'; }

// Greeting/system-init messages should never count as candidate prompts.
// These are auto-sent by AIAssistantPanel when a task tab opens.
const GREETING_PREFIXES = [
  'you are opening a new ai chat',
  'you are an ai assistant embedded',
];
function isGreetingMessage(i: any): boolean {
  const text = promptText(i);
  return GREETING_PREFIXES.some(prefix => text.startsWith(prefix));
}
/** Real user prompts: prompt_sent that are not platform-generated greeting messages */
function isRealUserPrompt(i: any): boolean {
  return eventType(i) === 'prompt_sent' && !isGreetingMessage(i);
}

// ── Prompt quality 0-100 ──────────────────────────────────────────────────────
/**
 * Higher = better prompts (clarifying, exploratory, specific).
 *
 * Baseline is 50 (neutral). Points are earned or lost based on signal quality.
 * 0 prompts → returns 0 (no data, not "perfect").
 * Generic prompts with no signal → ~50 (neutral).
 * Targeted, exploratory prompts → 65–85.
 * Solution-seeking / lazy prompts → 20–40.
 */
export function calculatePromptQuality(interactions: any[]): number {
  // Only real user prompts — exclude platform greeting/init messages
  const prompts = interactions.filter(i =>
    isRealUserPrompt(i) ||
    (eventType(i) === 'response_received' && (i.promptText || i.prompt_text) && !isGreetingMessage(i))
  );
  if (prompts.length === 0) return 0; // No prompts → no data, not a perfect score

  let totalDelta = 0;

  prompts.forEach((prompt: any) => {
    const text = promptText(prompt);
    if (!text) return;

    // Negative signals (lazy / solution-seeking)
    if (/solve.*entire|complete.*solution|write.*whole|do.*this.*for.*me/.test(text)) totalDelta -= 15;
    if (/give.*me.*the.*answer|just.*tell.*me|cheat/.test(text)) totalDelta -= 10;
    if (/^(fix this|write this|do this|help)\.?$/i.test(text.trim())) totalDelta -= 10; // one-liner demands

    // Positive signals (understanding-seeking, iterative)
    if (/explain|how.*work|what.*is|help.*understand|why/.test(text)) totalDelta += 8;
    if (/i.*tried|i.*think|my.*approach|does.*this.*look|i.*noticed/.test(text)) totalDelta += 8; // shows own thinking
    if (text.length > 200) totalDelta += 5; // detailed, context-rich prompt
    else if (text.length > 100) totalDelta += 2; // moderately detailed
    if (/show me|walk.*through|can you explain/.test(text)) totalDelta += 3; // guided exploration
  });

  // Volume penalty: excessive prompting suggests over-reliance
  if (prompts.length > 30) totalDelta -= 20;
  else if (prompts.length > 20) totalDelta -= 10;
  else if (prompts.length > 10) totalDelta -= 5;

  // Per-prompt average delta (avoid penalising/rewarding just from volume)
  const avgDelta = totalDelta / prompts.length;
  const score = 50 + Math.round(avgDelta * Math.min(prompts.length, 5)); // scale up to 5 prompts
  return Math.max(0, Math.min(100, score));
}

// ── Self-reliance 0-100 ───────────────────────────────────────────────────────
export function calculateSelfReliance(interactions: any[], _submissions: any[]): number {
  let score = 100;
  const prompts = interactions.filter(isRealUserPrompt);

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
    // Only count responses to real user prompts — exclude greeting/init auto-fires
    .filter(i => eventType(i) === 'response_received' && !isGreetingMessage(i))
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
  if (quality === 0) return 0; // no prompts → no IQ score
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
  // Only count real user prompts — exclude platform greeting/init messages
  const promptCount   = interactions.filter(isRealUserPrompt).length;
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
