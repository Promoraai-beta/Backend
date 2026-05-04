import { Router, Request, Response } from 'express';
import { streamText, jsonSchema, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { prisma } from '../lib/prisma';

const router = Router();

// ── Provider clients (keys live here in the backend only) ───────────────────
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? '',
});

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_AI_API_KEY ?? '',
});

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY ?? '',
});

/** Resolve the Vercel AI SDK model object from a model string */
function resolveModel(modelName: string) {
  if (modelName.startsWith('gemini-'))  return google(modelName);
  if (modelName.startsWith('claude-'))  return anthropic(modelName);
  if (modelName.startsWith('llama-') || modelName.startsWith('mixtral-') || modelName.startsWith('groq-')) return groq(modelName);
  return openai.chat(modelName as any);
}

// ── Interfaces ────────────────────────────────────────────────────────────────
interface ProblemContext {
  title?: string;
  description?: string;
  difficulty?: string;
  requirements?: string[];
}

type ToolDef<TArgs> = {
  description: string;
  inputSchema: ReturnType<typeof jsonSchema<TArgs>>;
  execute: (args: TArgs) => Promise<unknown>;
};

function makeTool<TArgs>(def: ToolDef<TArgs>) {
  return def;
}

// ── GET /api/ai/chat/providers — returns which providers have API keys configured ──
router.get('/providers', (_req: Request, res: Response) => {
  res.json({
    openai:    !!process.env.OPENAI_API_KEY,
    google:    !!process.env.GOOGLE_AI_API_KEY,
    groq:      !!process.env.GROQ_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Extract a Google resource ID (doc or sheet) from a Drive/Docs/Sheets URL */
function extractGoogleId(url: string): string | null {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  return m ? m[1] : null;
}

/** Flatten Google Docs structured body → plain text */
function extractDocText(doc: any): string {
  const parts: string[] = [];
  const traverse = (content: any[]) => {
    for (const elem of content ?? []) {
      if (elem.paragraph) {
        for (const pe of elem.paragraph.elements ?? []) {
          if (pe.textRun?.content) parts.push(pe.textRun.content);
        }
      } else if (elem.table) {
        for (const row of elem.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) {
            traverse(cell.content ?? []);
          }
        }
      }
    }
  };
  traverse(doc?.body?.content ?? []);
  return parts.join('');
}

/** Fetch and return a Google OAuth token — reuses the same service as docs.tool.ts */
async function getGoogleToken(): Promise<string | null> {
  try {
    const { getOAuthAccessToken } = await import('../services/google-auth');
    return await getOAuthAccessToken();
  } catch {
    return null;
  }
}

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body;

    const messages: Array<{ role: string; content: string }> = body.messages ?? [];
    const sessionId: string | undefined = body.sessionId;
    const currentProblem: ProblemContext | undefined = body.currentProblem;
    const currentProblemIndex: number = body.currentProblemIndex ?? 0;
    const allProblems: ProblemContext[] = body.allProblems ?? [];
    const role: string = body.role ?? 'candidate';
    const surface: string = body.surface ?? 'ide';
    const modelName: string = body.model || 'gpt-4o';
    const tabId: string | undefined = body.tabId;
    const conversationTurn: number = body.conversationTurn ?? 0;

    if (!messages.length) {
      return res.status(400).json({ error: 'No messages provided' });
    }

    // Resolve doc/sheet URLs from session toolResources so the AI tools can read/write them
    let docUrl: string | null = null;
    let sheetsUrl: string | null = null;
    if (sessionId) {
      try {
        const sess = await prisma.session.findUnique({
          where: { id: sessionId },
          select: { toolResources: true, sheetsFileUrl: true } as any,
        }) as any;
        const tr = (sess?.toolResources as any) ?? {};
        docUrl    = tr?.docs?.url    ?? null;
        sheetsUrl = tr?.sheets?.url  ?? sess?.sheetsFileUrl ?? null;
      } catch { /* non-fatal */ }
    }

    const systemPrompt = buildSystemPrompt({ sessionId, currentProblem, currentProblemIndex, allProblems, role, surface, hasDoc: !!docUrl, hasSheets: !!sheetsUrl });
    const promptText = messages.filter((m: any) => m.role === 'user').pop()?.content ?? '';
    const startTime = Date.now();

    // NOTE: prompt_sent is tracked client-side via useAIWatcher in AIAssistantPanel.
    // The backend only writes response_received (with accurate token counts from the API).
    // Do NOT add a prompt_sent write here — it would double-count every user message.

    const result = streamText({
      model: resolveModel(modelName),
      system: systemPrompt,
      messages: messages as any,
      stopWhen: stepCountIs(10),
      onError: (err) => {
        console.error('[AI Chat Backend] streamText error:', err);
      },
      tools: {
        list_files: makeTool<Record<string, never>>({
          description:
            "List all files in the candidate's workspace. Call this first to understand the project structure before reading specific files.",
          inputSchema: jsonSchema<Record<string, never>>({
            type: 'object',
            properties: {},
            additionalProperties: false,
          }),
          execute: async () => {
            if (!sessionId) return { error: 'No session ID — container file access unavailable' };
            try {
              const backendUrl = `http://localhost:${process.env.PORT || 5001}`;
              const r = await fetch(`${backendUrl}/api/sessions/${sessionId}/files`);
              if (!r.ok) return { error: `Backend returned ${r.status}` };
              const data = await r.json() as { files: string[] };
              return { files: data.files };
            } catch (e: any) {
              return { error: e.message };
            }
          },
        }),

        read_file: makeTool<{ path: string }>({
          description: 'Read the contents of a specific file in the workspace. Use list_files first to discover file paths.',
          inputSchema: jsonSchema<{ path: string }>({
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path, e.g. "src/App.tsx"' },
            },
            required: ['path'],
            additionalProperties: false,
          }),
          execute: async ({ path }: { path: string }) => {
            if (!sessionId) return { error: 'No session ID — container file access unavailable' };
            try {
              const backendUrl = `http://localhost:${process.env.PORT || 5001}`;
              const r = await fetch(`${backendUrl}/api/sessions/${sessionId}/files/${path}`);
              if (!r.ok) return { error: `Backend returned ${r.status}` };
              const data = await r.json() as { path: string; content: string };
              return { path: data.path, content: data.content };
            } catch (e: any) {
              return { error: e.message };
            }
          },
        }),

        write_file: makeTool<{ path: string; content: string }>({
          description:
            'DISABLED — do NOT use this tool. Always show code in a fenced markdown code block with `// File: path` on the first line so the candidate can review and click Apply.',
          inputSchema: jsonSchema<{ path: string; content: string }>({
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          }),
          execute: async ({ path }: { path: string; content: string }) => {
            return { error: `write_file is disabled. Show the code in a fenced block with "// File: ${path}" so the candidate can review and click Apply.` };
          },
        }),

        read_doc: makeTool<Record<string, never>>({
          description:
            "Read the current content of the candidate's Google Doc for this session. " +
            "Call this to understand what the candidate has written so far before suggesting additions or corrections.",
          inputSchema: jsonSchema<Record<string, never>>({
            type: 'object',
            properties: {},
            additionalProperties: false,
          }),
          execute: async () => {
            if (!docUrl) return { error: 'No Google Doc is attached to this session.' };
            const docId = extractGoogleId(docUrl);
            if (!docId) return { error: 'Could not extract document ID from doc URL.' };
            const token = await getGoogleToken();
            if (!token) return { error: 'Google OAuth token unavailable.' };
            try {
              const r = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!r.ok) return { error: `Docs API returned ${r.status}` };
              const doc = await r.json() as any;
              const text = extractDocText(doc);
              return { title: doc.title, content: text, charCount: text.length };
            } catch (e: any) {
              return { error: e.message };
            }
          },
        }),

        write_doc: makeTool<{ content: string; mode?: 'append' | 'replace' }>({
          description:
            "Write content to the candidate's Google Doc. " +
            "Use mode='append' (default) to add text at the end of the doc. " +
            "Use mode='replace' to replace the entire document body with new content. " +
            "Always call read_doc first so you understand what is already there.",
          inputSchema: jsonSchema<{ content: string; mode?: 'append' | 'replace' }>({
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Text to write into the document' },
              mode:    { type: 'string', enum: ['append', 'replace'], description: "append (default) or replace" },
            },
            required: ['content'],
            additionalProperties: false,
          }),
          execute: async ({ content, mode = 'append' }: { content: string; mode?: 'append' | 'replace' }) => {
            if (!docUrl) return { error: 'No Google Doc is attached to this session.' };
            const docId = extractGoogleId(docUrl);
            if (!docId) return { error: 'Could not extract document ID from doc URL.' };
            const token = await getGoogleToken();
            if (!token) return { error: 'Google OAuth token unavailable.' };
            try {
              const requests: any[] = [];
              if (mode === 'replace') {
                // Fetch current end index to delete the body first
                const getRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
                  headers: { Authorization: `Bearer ${token}` },
                });
                if (!getRes.ok) return { error: `Docs API returned ${getRes.status}` };
                const doc = await getRes.json() as any;
                const endIndex = doc?.body?.content?.at(-1)?.endIndex ?? 2;
                if (endIndex > 2) {
                  requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
                }
                requests.push({ insertText: { location: { index: 1 }, text: content } });
              } else {
                // append: insertText at endOfSegmentLocation
                requests.push({ insertText: { endOfSegmentLocation: {}, text: '\n' + content } });
              }
              const r = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ requests }),
              });
              if (!r.ok) {
                const err = await r.text();
                return { error: `Docs API batchUpdate failed (${r.status}): ${err.slice(0, 300)}` };
              }
              return { success: true, mode, charsWritten: content.length };
            } catch (e: any) {
              return { error: e.message };
            }
          },
        }),

        read_sheet: makeTool<{ range?: string }>({
          description:
            "Read cell values from the candidate's Google Sheet for this session. " +
            "Specify a range like 'Sheet1!A1:D20' or leave empty to read the first sheet's used range.",
          inputSchema: jsonSchema<{ range?: string }>({
            type: 'object',
            properties: {
              range: { type: 'string', description: "A1 notation range, e.g. 'Sheet1!A1:F50'. Defaults to first sheet." },
            },
            additionalProperties: false,
          }),
          execute: async ({ range }: { range?: string }) => {
            if (!sheetsUrl) return { error: 'No Google Sheet is attached to this session.' };
            const sheetId = extractGoogleId(sheetsUrl);
            if (!sheetId) return { error: 'Could not extract spreadsheet ID from sheet URL.' };
            const token = await getGoogleToken();
            if (!token) return { error: 'Google OAuth token unavailable.' };
            try {
              const effectiveRange = range || 'A1:Z1000';
              const encodedRange = encodeURIComponent(effectiveRange);
              const r = await fetch(
                `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodedRange}`,
                { headers: { Authorization: `Bearer ${token}` } },
              );
              if (!r.ok) return { error: `Sheets API returned ${r.status}` };
              const data = await r.json() as any;
              return {
                range: data.range,
                values: data.values ?? [],
                rowCount: (data.values ?? []).length,
              };
            } catch (e: any) {
              return { error: e.message };
            }
          },
        }),

        write_sheet: makeTool<{ range: string; values: string[][] }>({
          description:
            "Write values to a range of cells in the candidate's Google Sheet. " +
            "Always call read_sheet first to understand the current data before overwriting.",
          inputSchema: jsonSchema<{ range: string; values: string[][] }>({
            type: 'object',
            properties: {
              range:  { type: 'string', description: "A1 notation range, e.g. 'Sheet1!A2:D5'" },
              values: {
                type: 'array',
                description: '2D array of cell values, row-major, e.g. [["Name","Score"],["Alice","95"]]',
                items: { type: 'array', items: { type: 'string' } },
              },
            },
            required: ['range', 'values'],
            additionalProperties: false,
          }),
          execute: async ({ range, values }: { range: string; values: string[][] }) => {
            if (!sheetsUrl) return { error: 'No Google Sheet is attached to this session.' };
            const sheetId = extractGoogleId(sheetsUrl);
            if (!sheetId) return { error: 'Could not extract spreadsheet ID from sheet URL.' };
            const token = await getGoogleToken();
            if (!token) return { error: 'Google OAuth token unavailable.' };
            try {
              const encodedRange = encodeURIComponent(range);
              const r = await fetch(
                `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodedRange}?valueInputOption=USER_ENTERED`,
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
                },
              );
              if (!r.ok) {
                const err = await r.text();
                return { error: `Sheets API write failed (${r.status}): ${err.slice(0, 300)}` };
              }
              const data = await r.json() as any;
              return { success: true, updatedRange: data.updatedRange, updatedCells: data.updatedCells };
            } catch (e: any) {
              return { error: e.message };
            }
          },
        }),

        run_command: makeTool<{ command: string; cwd?: string; timeout?: number }>({
          description:
            "Run a shell command in the candidate's workspace ONLY when the candidate explicitly asks you to run it. " +
            "Do NOT call this tool automatically or proactively. " +
            "Returns stdout, stderr, and exit code. Do NOT run destructive commands like rm -rf.",
          inputSchema: jsonSchema<{ command: string; cwd?: string; timeout?: number }>({
            type: 'object',
            properties: {
              command: { type: 'string', description: "Shell command to run, e.g. 'npm test' or 'pytest -v'" },
              cwd: { type: 'string', description: "Subdirectory within workspace, e.g. 'frontend' or 'backend'" },
              timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000)' },
            },
            required: ['command'],
            additionalProperties: false,
          }),
          execute: async ({ command, cwd, timeout }: { command: string; cwd?: string; timeout?: number }) => {
            if (!sessionId) return { error: 'No session ID — cannot run commands without a live container' };
            try {
              const backendUrl = `http://localhost:${process.env.PORT || 5001}`;
              const r = await fetch(`${backendUrl}/api/sessions/${sessionId}/exec`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command, cwd, timeout }),
                signal: AbortSignal.timeout((timeout || 30000) + 5000),
              });
              if (!r.ok) {
                const err = await r.json().catch(() => ({}));
                return { error: (err as any).error || `Backend returned ${r.status}` };
              }
              const data = await r.json() as any;
              return {
                command: data.command,
                cwd: data.cwd,
                exitCode: data.exitCode,
                stdout: (data.stdout as string)?.slice(-4000) || '',
                stderr: (data.stderr as string)?.slice(-2000) || '',
                success: data.success,
              };
            } catch (e: any) {
              return { error: e.message };
            }
          },
        }),
      } as any,
    });

    // Stream the response as plain text
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present

    let fullResponse = '';
    try {
      for await (const chunk of result.textStream) {
        fullResponse += chunk;
        res.write(chunk);
      }
    } catch (streamErr) {
      console.error('[AI Chat Backend] textStream error:', streamErr);
    } finally {
      res.end();
    }

    // Fire-and-forget: save interaction to DB after stream completes
    if (sessionId) {
      try {
        const usage = await result.usage;
        const latencyMs = Date.now() - startTime;
        const promptTokens = usage?.inputTokens ?? 0;
        const completionTokens = usage?.outputTokens ?? 0;

        // Validate session exists before inserting
        const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true } });
        if (session) {
          await prisma.aiInteraction.create({
            data: {
              sessionId,
              eventType: 'response_received',
              model: modelName,
              promptText: promptText.substring(0, 10000),
              responseText: fullResponse.substring(0, 50000),
              promptTokens,
              completionTokens,
              tokensUsed: promptTokens + completionTokens,
              latencyMs,
              tabId: tabId || null,
              conversationTurn: conversationTurn || null,
            },
          });
        }
      } catch (dbErr) {
        console.error('[AI Chat Backend] Failed to save interaction:', dbErr);
      }
    }
  } catch (err: any) {
    console.error('[AI Chat Backend] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message ?? 'Unknown error' });
    }
  }
});

// ── System prompt builder ─────────────────────────────────────────────────────
interface SystemPromptParams {
  sessionId?: string;
  currentProblem?: ProblemContext;
  currentProblemIndex: number;
  allProblems: ProblemContext[];
  role: string;
  surface: string;
  hasDoc?: boolean;
  hasSheets?: boolean;
}

function buildSystemPrompt({ sessionId, currentProblem, currentProblemIndex, allProblems, role, surface, hasDoc, hasSheets }: SystemPromptParams): string {
  const containerNote = sessionId
    ? "You have direct access to the candidate's workspace via list_files and read_file tools. " +
      "Always call list_files then read_file before suggesting changes — never write blindly. " +
      "run_command is also available but ONLY use it when the candidate explicitly asks you to run a command."
    : 'No live container is attached — you cannot access workspace files or run commands right now.';

  const docNote = hasDoc
    ? "You also have read_doc and write_doc tools for the candidate's Google Doc. " +
      "Use read_doc to see what they've written. Use write_doc (mode='append') to add content, or mode='replace' to rewrite the whole doc."
    : '';

  const sheetsNote = hasSheets
    ? "You also have read_sheet and write_sheet tools for the candidate's Google Sheet. " +
      "Use read_sheet to inspect the data, write_sheet to update cell ranges."
    : '';

  const tasksContext = allProblems.length > 0
    ? `\n\n## Assessment Tasks (${allProblems.length} total)\n` +
      allProblems.map((p, i) => {
        const isCurrent = i === currentProblemIndex;
        const label = isCurrent ? `**Task ${i + 1} [CURRENT]**: ${p.title ?? 'Untitled'}` : `Task ${i + 1}: ${p.title ?? 'Untitled'}`;
        const diff = p.difficulty ? ` (${p.difficulty})` : '';
        const desc = p.description ? `\n   ${p.description}` : '';
        const reqs = p.requirements?.length
          ? `\n   Requirements:\n${p.requirements.map(r => `   - ${r}`).join('\n')}`
          : '';
        return `${label}${diff}${desc}${reqs}`;
      }).join('\n\n')
    : currentProblem?.title
      ? `\n\nCurrent task: **${currentProblem.title}**\n${currentProblem.description ?? ''}${
          currentProblem.requirements?.length
            ? `\nRequirements:\n${currentProblem.requirements.map(r => `- ${r}`).join('\n')}`
            : ''
        }`
      : '';

  const roleGuard =
    role === 'candidate'
      ? `You are helping a candidate during a technical assessment. Be encouraging and helpful.
- ${containerNote}${docNote ? '\n- ' + docNote : ''}${sheetsNote ? '\n- ' + sheetsNote : ''}
- You know ALL the tasks listed above — you can answer questions about any of them, not just the current one.
- NEVER use write_file to apply changes — it is disabled. Instead, ALWAYS show your fix as a fenced markdown code block. The FIRST line inside the block MUST be a comment with the EXACT relative file path as returned by list_files (e.g. if list_files returns "frontend/src/App.tsx", use that full path):
  \`\`\`tsx
  // File: frontend/src/App.tsx
  // ... fixed code here ...
  \`\`\`
  The UI will show an **Apply** button the candidate can click to apply the change to their workspace. Always read_file first so you know the exact current path and content before suggesting changes.
- Guide toward the answer rather than giving the complete solution immediately.
- NEVER call run_command automatically. Only call it when the candidate explicitly says something like "run my tests" or "can you run npm test".
- Never allow submission, timer changes, or access to other candidates' data.`
      : `You are helping a recruiter review assessments and candidates.
- ${containerNote}${docNote ? '\n- ' + docNote : ''}${sheetsNote ? '\n- ' + sheetsNote : ''}
- You have full context on all tasks in the assessment.
- Do NOT modify submissions or scores.`;

  const surfaceHint =
    surface === 'docs'     ? 'The candidate is currently on the **Docs tab** — prioritise read_doc / write_doc tools.' :
    surface === 'sheets'   ? 'The candidate is currently on the **Sheets tab** — prioritise read_sheet / write_sheet tools.' :
    surface === 'database' ? 'The candidate is currently on the **Database tab** — they are working with SQL and the live database.' :
    surface === 'code' || surface === 'ide'
                           ? 'The candidate is currently in the **Code Editor** — prioritise list_files / read_file / run_command tools.' :
    '';

  return `You are the Promora AI Assistant — a unified coding and documentation assistant embedded in the Promora assessment platform.
Surface: ${surface} | Role: ${role}${surfaceHint ? '\n' + surfaceHint : ''}${tasksContext}

${roleGuard}

Be concise. Prefer code examples over long explanations. Always read the relevant resource (read_file / read_doc / read_sheet) before suggesting or writing changes.`;
}

export default router;
