/**
 * Gemini Video Analysis Service
 *
 * Analyzes a candidate's screenshare recording using Gemini 2.0 Flash multimodal.
 * Triggered once at session end — no polling, no per-minute calls.
 *
 * Strategy: ffmpeg frame extraction (100% coverage)
 * ────────────────────────────────────────────────
 * 1. Download ALL screenshare chunks from Supabase Storage
 * 2. Concatenate into a single WebM temp file
 * 3. Use ffmpeg to extract one JPEG frame every 30 seconds
 * 4. Send all frames as inline images in a single Gemini generateContent call
 *
 * Coverage: entire session, zero blind spots
 * Cost estimate: ~90 frames for 45-min session × ~85 tokens/frame = ~7650 tokens ≈ $0.001
 * No Files API upload/polling overhead — direct inline_data in the request body.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { prisma } from '../lib/prisma';
import { sanitizeName } from '../lib/storage-utils';
import { logger } from '../lib/logger';
import ffmpeg from 'fluent-ffmpeg';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GeminiVideoAnalysis {
  summary: string;
  timeOnTask: string;
  toolsObserved: string[];
  suspiciousActivity: string[];
  codingBehavior: string;
  keyMoments: Array<{ timestamp: string; observation: string }>;
  overallVerdict: 'focused' | 'somewhat_distracted' | 'distracted';
  confidence: 'high' | 'medium' | 'low';
  framesAnalyzed: number;
  totalChunks: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
const VERTEX_LOCATION = 'us-central1';

// ── Vertex AI auth (uses GOOGLE_SERVICE_ACCOUNT_JSON) ─────────────────────────

async function getVertexAccessToken(): Promise<string | null> {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) return null;
  try {
    const sa = JSON.parse(saJson);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsigned);
    const signature = sign.sign(sa.private_key, 'base64url');
    const jwt = `${unsigned}.${signature}`;

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    if (!r.ok) {
      logger.warn(`[GeminiVideo] Vertex auth token exchange failed: ${r.status}`);
      return null;
    }
    const data = (await r.json()) as any;
    return data.access_token || null;
  } catch (e: any) {
    logger.warn(`[GeminiVideo] Vertex auth error: ${e.message}`);
    return null;
  }
}

async function callVertexGemini(imageParts: any[], prompt: string, model: string): Promise<string | null> {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) return null;
  const sa = JSON.parse(saJson);
  const projectId = sa.project_id;

  const accessToken = await getVertexAccessToken();
  if (!accessToken) {
    logger.warn('[GeminiVideo] Could not obtain Vertex AI access token');
    return null;
  }

  // Try models in order until one succeeds (handles region availability differences)
  const modelCandidates = [...new Set([model, 'gemini-1.5-flash-002', 'gemini-2.0-flash-001', 'gemini-1.5-flash'])];

  for (const vertexModel of modelCandidates) {
    const endpoint = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${vertexModel}:generateContent`;
    logger.log(`[GeminiVideo] Calling Vertex AI (project: ${projectId}, model: ${vertexModel})`);

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [...imageParts, { text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e: any) {
      logger.error(`[GeminiVideo] Vertex AI network error (${vertexModel}): ${e.message}`);
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as any;
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    }

    const errText = await res.text();
    logger.warn(`[GeminiVideo] Vertex AI ${res.status} for ${vertexModel}: ${errText.slice(0, 200)}`);
    // 404 = model not found in this project, try next; other errors = stop
    if (res.status !== 404) break;
  }

  logger.error('[GeminiVideo] All Vertex AI model attempts failed');
  return null;
}
// ── OpenAI GPT-4o Vision fallback ────────────────────────────────────────────

async function callOpenAIVision(frames: string[], prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || 'gpt-4o';

  // Cap at 20 frames to stay within 30k TPM limit (20 × 85 tokens = 1,700 image tokens)
  const cappedFrames = frames.slice(0, 20);

  const imageMessages = cappedFrames.map(b64 => ({
    type: 'image_url' as const,
    image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' as const },
  }));

  const body = {
    model,
    max_tokens: 1500,
    messages: [
      {
        role: 'user' as const,
        content: [
          ...imageMessages,
          { type: 'text' as const, text: prompt },
        ],
      },
    ],
  };

  logger.log(`[GeminiVideo] Calling OpenAI ${model} with ${cappedFrames.length} frames...`);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.error(`[GeminiVideo] OpenAI failed: ${res.status} ${errText.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as any;
    return data?.choices?.[0]?.message?.content || null;
  } catch (e: any) {
    logger.error(`[GeminiVideo] OpenAI network error: ${e.message}`);
    return null;
  }
}

/** Extract one frame every N seconds */
const FRAME_INTERVAL_SECONDS = 30;
/** Max frames to send (safety cap — 90 = 45-min session at 30s interval) */
const MAX_FRAMES = 120;
/** Max total inline image bytes (~15 MB) */
const MAX_INLINE_BYTES = 15 * 1024 * 1024;

// ── Supabase chunk fetcher ────────────────────────────────────────────────────

interface ChunkMeta {
  index: number;
  name: string;
  publicUrl: string;
}

async function listScreenshareChunks(sessionId: string): Promise<ChunkMeta[]> {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
  if (!supabaseUrl || !supabaseKey) return [];

  const supabase = createClient(supabaseUrl, supabaseKey);
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { assessment: { include: { company: true } } },
  });
  if (!session) return [];

  const companyName = session.assessment?.company?.name || 'UnknownCompany';
  const jobName = (session.assessment as any)?.jobTitle || (session.assessment as any)?.role || 'UnknownJob';
  const candidateName = session.candidateName || session.sessionCode || 'UnknownCandidate';

  const prefix = ['companies', sanitizeName(companyName), 'jobs', sanitizeName(jobName), sanitizeName(candidateName), 'screenshare'].join('/');

  const { data: files, error } = await supabase.storage
    .from(bucket)
    .list(prefix, { limit: 2000, sortBy: { column: 'name', order: 'asc' } });

  if (error || !files) {
    logger.warn(`[GeminiVideo] Could not list chunks at "${prefix}": ${error?.message}`);
    return [];
  }

  return files
    .filter(f => f.name.endsWith('.webm'))
    .map(f => {
      const match = f.name.match(/^chunk_(\d+)(?:_\d+)?\.webm$/);
      const index = match ? parseInt(match[1], 10) : -1;
      const filePath = `${prefix}/${f.name}`;
      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filePath);
      return { index, name: f.name, publicUrl: urlData.publicUrl };
    })
    .filter(c => c.index >= 0)
    .sort((a, b) => a.index - b.index);
}

// ── ffmpeg frame extractor ────────────────────────────────────────────────────

/**
 * Extract JPEG frames every FRAME_INTERVAL_SECONDS from a video file.
 * Returns an array of base64-encoded JPEG strings.
 */
function extractFrames(videoPath: string, outputDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        `-vf fps=1/${FRAME_INTERVAL_SECONDS}`,  // one frame per interval
        '-q:v 5',                                // JPEG quality (1=best, 31=worst)
        '-frames:v ' + MAX_FRAMES,               // safety cap
      ])
      .output(path.join(outputDir, 'frame_%04d.jpg'))
      .on('end', () => {
        try {
          const files = fs.readdirSync(outputDir)
            .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
            .sort();

          const frames: string[] = [];
          let totalBytes = 0;

          for (const file of files) {
            const buf = fs.readFileSync(path.join(outputDir, file));
            totalBytes += buf.byteLength;
            if (totalBytes > MAX_INLINE_BYTES) break;
            frames.push(buf.toString('base64'));
          }

          resolve(frames);
        } catch (e: any) {
          reject(e);
        }
      })
      .on('error', reject)
      .run();
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function analyzeSessionVideo(sessionId: string): Promise<GeminiVideoAnalysis | null> {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  // Require OpenAI API key (primary provider for video analysis)
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (!hasOpenAI) {
    logger.warn('[GeminiVideo] No OPENAI_API_KEY configured — skipping video analysis');
    return null;
  }

  // ── 1. List all chunks ───────────────────────────────────────────────────
  const allChunks = await listScreenshareChunks(sessionId);
  if (allChunks.length === 0) {
    logger.log(`[GeminiVideo] No screenshare chunks for session ${sessionId} — skipping`);
    return null;
  }

  logger.log(`[GeminiVideo] Found ${allChunks.length} chunks for session ${sessionId}`);

  // ── 2. Create temp directory ─────────────────────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `gemini-${sessionId}-`));
  const videoPath = path.join(tmpDir, 'session.webm');
  const framesDir = path.join(tmpDir, 'frames');
  fs.mkdirSync(framesDir);

  try {
    // ── 3. Download ALL chunks and concatenate ───────────────────────────
    logger.log(`[GeminiVideo] Downloading ${allChunks.length} chunks...`);
    const CONCURRENCY = 8;
    const buffers: (Buffer | null)[] = new Array(allChunks.length).fill(null);

    for (let i = 0; i < allChunks.length; i += CONCURRENCY) {
      const batch = allChunks.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (chunk, batchIdx) => {
        try {
          const r = await fetch(chunk.publicUrl, { signal: AbortSignal.timeout(20_000) });
          if (r.ok) buffers[i + batchIdx] = Buffer.from(await r.arrayBuffer());
        } catch (e: any) {
          logger.warn(`[GeminiVideo] Failed chunk ${chunk.name}: ${e.message}`);
        }
      }));
    }

    const validBuffers = buffers.filter(Boolean) as Buffer[];
    if (validBuffers.length === 0) {
      logger.warn(`[GeminiVideo] All chunk downloads failed for session ${sessionId}`);
      return null;
    }

    // Write concatenated WebM to temp file
    const merged = Buffer.concat(validBuffers);
    fs.writeFileSync(videoPath, merged);
    logger.log(`[GeminiVideo] Wrote ${(merged.byteLength / 1024 / 1024).toFixed(2)} MB video to temp file`);

    // ── 4. Extract frames via ffmpeg ────────────────────────────────────
    logger.log(`[GeminiVideo] Extracting frames every ${FRAME_INTERVAL_SECONDS}s...`);
    const frames = await extractFrames(videoPath, framesDir);

    if (frames.length === 0) {
      logger.warn('[GeminiVideo] No frames extracted — video may be corrupt or ffmpeg unavailable');
      return null;
    }

    logger.log(`[GeminiVideo] Extracted ${frames.length} frames — sending to Gemini`);

    // ── 5. Build analysis prompt ─────────────────────────────────────────
    const sessionDurationMin = Math.round((allChunks.length * 5) / 60); // rough estimate
    const prompt = `You are a senior technical recruiter and integrity analyst reviewing screenshots from a candidate's screenshare during a ${sessionDurationMin}-minute online coding assessment on PromoraAI. You are seeing ${frames.length} frames captured every ${FRAME_INTERVAL_SECONDS} seconds — complete coverage of the entire session.

Analyze ALL frames carefully. Your primary mission is to detect whether the candidate used ANY external resources, tools, or websites that were NOT part of the official assessment platform.

CRITICAL DETECTION TARGETS — flag immediately if you see ANY of these:
- Google, Bing, DuckDuckGo or any search engine (even briefly)
- ChatGPT (chat.openai.com), Claude (claude.ai), Gemini (gemini.google.com), Perplexity, or any AI chatbot website
- Stack Overflow, Stack Exchange, GeeksforGeeks, LeetCode, HackerRank, or any Q&A / coding-problem site
- GitHub Copilot chat panel, Cursor AI, or any IDE-embedded AI beyond what the platform provides
- YouTube, Reddit, Medium, dev.to, or any content/tutorial site
- Any new browser tab opening (especially if it looks different from the assessment platform)
- Copy-pasting code from external sites into the editor
- Reading a solution from another window then typing it in
- Tab switching — disappearing from the assessment window for more than a few seconds

The legitimate assessment platform looks like a dark-themed coding environment. Anything else is potentially suspicious.

Respond ONLY with valid JSON. No markdown fences, no extra text.

{
  "summary": "2-3 sentence overview of what the candidate did throughout the session",
  "timeOnTask": "Estimated % of the session spent on the actual assessment task (e.g. '~80%')",
  "toolsObserved": ["list every tool, website, IDE feature, or AI assistant seen — be specific with URLs/names if visible"],
  "suspiciousActivity": ["describe EACH violation precisely, e.g. 'at ~8 min: searched Google for the exact problem statement', 'at ~15 min: opened ChatGPT and pasted code', 'multiple tab switches away from platform' — empty array if none detected"],
  "codingBehavior": "How did they code? Typed themselves / pasted from external site / AI-generated / mix — be specific",
  "keyMoments": [
    { "timestamp": "e.g. '~5 min'", "observation": "what happened" }
  ],
  "overallVerdict": "focused | somewhat_distracted | distracted",
  "confidence": "high | medium | low"
}

Assessment criteria:
- "focused": stayed on the assessment platform the entire time, coded independently
- "somewhat_distracted": brief non-assessment activity (docs, brief tab switch) but mostly on task
- "distracted": used external search/AI tools, spent significant time off-platform, or copied solutions

Be fair, objective, and specific. Only report what is clearly visible in the frames. If you cannot tell from the frames, say so in the summary but do not invent violations.`;

    // ── Call OpenAI GPT-4o Vision (primary provider) ────────────────────
    logger.log('[GeminiVideo] Calling OpenAI GPT-4o Vision...');
    let text: string | undefined = (await callOpenAIVision(frames, prompt)) ?? undefined;

    if (!text) {
      logger.error('[GeminiVideo] All AI providers failed — giving up');
      return null;
    }

    const cleanText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleanText);
    } catch (e: any) {
      logger.error(`[GeminiVideo] Failed to parse Gemini JSON: ${e.message}\nRaw: ${cleanText.slice(0, 200)}`);
      return null;
    }

    const result: GeminiVideoAnalysis = {
      summary: parsed.summary || '',
      timeOnTask: parsed.timeOnTask || 'unknown',
      toolsObserved: Array.isArray(parsed.toolsObserved) ? parsed.toolsObserved : [],
      suspiciousActivity: Array.isArray(parsed.suspiciousActivity) ? parsed.suspiciousActivity : [],
      codingBehavior: parsed.codingBehavior || '',
      keyMoments: Array.isArray(parsed.keyMoments) ? parsed.keyMoments : [],
      overallVerdict: ['focused', 'somewhat_distracted', 'distracted'].includes(parsed.overallVerdict)
        ? parsed.overallVerdict : 'focused',
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
      framesAnalyzed: frames.length,
      totalChunks: allChunks.length,
    };

    logger.log(`[GeminiVideo] ✅ Analysis complete — verdict: ${result.overallVerdict} (${result.confidence} confidence, ${frames.length} frames)`);
    return result;

  } finally {
    // Always clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
