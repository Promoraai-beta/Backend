/**
 * Session Judge: LLM-based evaluation of whole assessment flow.
 * Judges integrity + AI usage quality across the entire session (end-to-end).
 */

import OpenAI from 'openai';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const MAX_EVENTS = 80;
const MODEL = process.env.OPENAI_JUDGE_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

export interface JudgeResult {
  integrity_verdict: 'pass' | 'warn' | 'fail';
  ai_usage_quality_score: number;
  ai_usage_narrative: string;
  strengths: string[];
  weaknesses: string[];
  /** 1-2 sentence recruiter summary: how well does this candidate fit? */
  candidate_fit_summary?: string;
}

function formatEvent(ev: any): string {
  const ts = ev.timestamp ? new Date(ev.timestamp).toISOString().slice(11, 19) : '?';
  const type = ev.eventType || ev.event_type || 'unknown';
  const meta = ev.metadata && typeof ev.metadata === 'object' ? ev.metadata : {};
  switch (type) {
    case 'prompt_sent':
      return `[${ts}] PROMPT: "${(ev.promptText || '').slice(0, 150)}${(ev.promptText || '').length > 150 ? '...' : ''}"`;
    case 'response_received':
      return `[${ts}] AI_RESPONSE (${((ev.responseText || '').length / 100).toFixed(0)}x100 chars)`;
    case 'code_copied_from_ai':
    case 'code_pasted_from_ai':
      const lines = (ev.codeSnippet || '').split('\n').length;
      return `[${ts}] COPY/PASTE_FROM_AI: ${lines} lines`;
    case 'code_modified':
      return `[${ts}] CODE_MODIFIED`;
    case 'file_created':
      return `[${ts}] FILE_CREATED: ${meta.filePath || meta.fileName || '?'}`;
    case 'file_modified':
      return `[${ts}] FILE_MODIFIED: ${meta.filePath || meta.fileName || '?'}`;
    case 'file_deleted':
      return `[${ts}] FILE_DELETED`;
    case 'file_renamed':
      return `[${ts}] FILE_RENAMED: ${meta.oldPath || '?'} → ${meta.newPath || meta.newName || '?'}`;
    case 'terminal_spawned':
      return `[${ts}] TERMINAL_SPAWNED`;
    case 'command_executed':
      return `[${ts}] CMD: ${(meta.command || '').slice(0, 60)}`;
    case 'assessment_tab_switched':
      return `[${ts}] TAB: ${meta.tab || '?'}`;
    case 'assessment_problem_focused':
      return `[${ts}] PROBLEM: ${meta.problemTitle || (meta.problemIndex ?? '?')}`;
    case 'browser_tab_left':
      return `[${ts}] BROWSER_TAB_LEFT`;
    case 'assessment_run_code':
      return `[${ts}] RUN_CODE: problem ${meta.problemIndex ?? '?'}`;
    case 'assessment_submission':
      return `[${ts}] SUBMISSION (IDE=${meta.isIDEChallenge})`;
    case 'assessment_session_ended':
      return `[${ts}] SESSION_ENDED`;
    default:
      return `[${ts}] ${type}`;
  }
}

export async function judgeSession(
  sessionId: string,
  options?: { truncateEvents?: number }
): Promise<JudgeResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('[SessionJudge] OPENAI_API_KEY not set, skipping');
    return null;
  }

  try {
    const limit = options?.truncateEvents ?? MAX_EVENTS;
    const all = await prisma.aiInteraction.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' }
    });
    const events = all.slice(-limit);
    if (events.length === 0) {
      return {
        integrity_verdict: 'pass',
        ai_usage_quality_score: 5,
        ai_usage_narrative: 'No activity recorded yet.',
        strengths: [],
        weaknesses: [],
        candidate_fit_summary: 'No activity recorded yet. Cannot assess candidate fit.'
      };
    }

    const timeline = events.map(formatEvent).join('\n');
    const systemPrompt = `You are a judge for a coding assessment. You evaluate the candidate's session across two dimensions:
1. INTEGRITY: Did they follow the rules? (no excessive copy-paste from AI, no asking for full solutions, no suspicious patterns like browser_tab_left often, no obvious cheating)
2. AI USAGE: How well did they use AI? (productive prompts vs lazy ones, adapted AI output vs blind paste, used AI as a tool vs shortcut)

You see a chronological timeline of events. Use your judgment. Return ONLY valid JSON with no extra text:
{
  "integrity_verdict": "pass" | "warn" | "fail",
  "ai_usage_quality_score": 1-10,
  "ai_usage_narrative": "2-4 sentence summary of their AI usage and integrity",
  "strengths": ["strength1", "strength2"],
  "weaknesses": ["weakness1", "weakness2"],
  "candidate_fit_summary": "1-2 sentence recruiter summary: is this candidate a good fit? What stands out (positive or negative)?"
}`;

    const userPrompt = `Timeline of session events (oldest to newest):\n\n${timeline}\n\nEvaluate integrity and AI usage. Return JSON only.`;

    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as JudgeResult;
    if (!parsed.integrity_verdict || typeof parsed.ai_usage_quality_score !== 'number') {
      return null;
    }
    parsed.integrity_verdict = parsed.integrity_verdict as 'pass' | 'warn' | 'fail';
    if (!['pass', 'warn', 'fail'].includes(parsed.integrity_verdict)) {
      parsed.integrity_verdict = 'pass';
    }
    parsed.strengths = Array.isArray(parsed.strengths) ? parsed.strengths : [];
    parsed.weaknesses = Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [];
    parsed.ai_usage_narrative = parsed.ai_usage_narrative || '';
    parsed.candidate_fit_summary = parsed.candidate_fit_summary || '';

    return parsed;
  } catch (err: any) {
    logger.error('[SessionJudge] Failed for session', sessionId, err?.message || err);
    return null;
  }
}
