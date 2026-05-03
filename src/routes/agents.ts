import { Router, Request, Response } from 'express';
import { watchSession, executeAnalysis, flagSanityChecks } from '../mcp/servers/serverC';
import { authenticate } from '../middleware/rbac';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { computeSessionMetrics } from '../services/metrics';

const router = Router();

// All agent endpoints require authentication (recruiter-only)
router.use(authenticate);

// Helper function to verify session access
async function verifySessionAccess(sessionId: string, userId: string, userRole: string): Promise<boolean> {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        assessment: {
          include: {
            company: true
          }
        }
      }
    });

    if (!session) return false;

    // Candidates can access their own sessions (e.g. results page)
    if (userRole === 'candidate' && session.candidateId === userId) return true;

    // Only recruiter assessments are accessible for recruiters
    if (session.assessment?.assessmentType !== 'recruiter') return false;

    // Verify recruiter has access to this company's assessments
    if (userRole === 'recruiter' && session.assessment?.company?.id) {
      const recruiter = await prisma.recruiterProfile.findUnique({
        where: { userId: userId },
        include: { company: true }
      });
      return recruiter?.companyId === session.assessment.company.id;
    }

    return userRole === 'recruiter';
  } catch (error) {
    logger.error('Error verifying session access:', error);
    return false;
  }
}

// Get real-time violations using MCP Server C (Agent 6)
router.get('/watcher/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    // Verify access
    const hasAccess = await verifySessionAccess(sessionId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied to this session' });
    }

    // Use MCP Server C Agent 6
    const result = await watchSession(sessionId, true, true);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get comprehensive analysis using MCP Server C (Agent 7)
router.get('/extractor/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    // Verify access
    const hasAccess = await verifySessionAccess(sessionId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied to this session' });
    }

    // Use MCP Server C Agent 7
    const result = await executeAnalysis(sessionId);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get risk assessment using MCP Server C (Agent 8)
router.get('/sanity/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    // Verify access
    const hasAccess = await verifySessionAccess(sessionId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied to this session' });
    }

    // Use MCP Server C Agent 8
    const result = await flagSanityChecks(sessionId);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get complete report (all MCP Server C agents)
// Stores results in database for faster subsequent retrievals
router.get('/full-report/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    const forceRefresh = req.query.refresh === 'true'; // Optional: force recomputation

    // Verify access
    const hasAccess = await verifySessionAccess(sessionId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied to this session' });
    }

    // Compute session metrics (promptQuality, selfReliance) from interactions
    const [interactions, submissions] = await Promise.all([
      prisma.aiInteraction.findMany({ where: { sessionId }, orderBy: { timestamp: 'asc' } }),
      prisma.submission.findMany({ where: { sessionId }, orderBy: { submittedAt: 'desc' } })
    ]);
    const metrics = computeSessionMetrics(interactions, submissions);

    // Check if insights exist in database (unless force refresh)
    if (!forceRefresh) {
      const existingInsights = await prisma.agentInsight.findUnique({
        where: { sessionId }
      });

      if (existingInsights && existingInsights.extractor && existingInsights.sanity) {
        // Return cached insights only when all agents have data — partial cache is stale
        logger.log(`📊 Returning cached agent insights for session ${sessionId} (computed at: ${existingInsights.computedAt})`);
        return res.json({
          success: true,
          report: {
            watcher: existingInsights.watcher || null,
            extractor: existingInsights.extractor || null,
            sanity: existingInsights.sanity || null,
            judge: existingInsights.judge || null,
            geminiVideoAnalysis: (existingInsights as any).geminiVideoAnalysis || null,
            metrics: {
              promptQuality:  metrics.promptQuality,
              selfReliance:   metrics.selfReliance,
              promptIQ:       metrics.promptIQ,
              promptCount:    metrics.promptCount,
              copyCount:      metrics.copyCount,
              applyCount:     metrics.applyCount,
              totalTokens:    metrics.totalTokens,
              modelSwitches:  metrics.modelSwitches,
              modelBreakdown: metrics.modelBreakdown,
            }
          },
          cached: true,
          computedAt: existingInsights.computedAt,
          version: existingInsights.version
        });
      }
    }

    // No cached insights or force refresh - compute new insights
    logger.log(`🔄 Computing new agent insights for session ${sessionId}...`);
    
    // Run all MCP Server C agents in parallel for faster response
    const [watcher, extractor, sanity] = await Promise.all([
      watchSession(sessionId, true, true).catch(err => {
        logger.error('Watcher agent error:', err);
        return { success: false, error: err.message, violations: [], riskScore: 0 };
      }),
      executeAnalysis(sessionId).catch(err => {
        logger.error('Extractor agent error:', err);
        return { success: false, error: err.message, behaviorScore: 0 };
      }),
      flagSanityChecks(sessionId).catch(err => {
        logger.error('Sanity agent error:', err);
        return { success: false, error: err.message, redFlags: [], riskScore: 0 };
      })
    ]);

    // Store insights in database (upsert - create or update)
    try {
      const existing = await prisma.agentInsight.findUnique({
        where: { sessionId }
      });

      if (existing) {
        // Update existing insights
        await prisma.agentInsight.update({
          where: { sessionId },
          data: {
            watcher: watcher as any,
            extractor: extractor as any,
            sanity: sanity as any,
            computedAt: new Date(),
            version: existing.version + 1,
            updatedAt: new Date()
          }
        });
        logger.log(`✅ Updated agent insights for session ${sessionId} (version ${existing.version + 1})`);
      } else {
        // Create new insights
        await prisma.agentInsight.create({
          data: {
            sessionId,
            watcher: watcher as any,
            extractor: extractor as any,
            sanity: sanity as any,
            computedAt: new Date(),
            version: 1
          }
        });
        logger.log(`✅ Stored new agent insights for session ${sessionId}`);
      }
    } catch (dbError: any) {
      // Log error but don't fail the request - insights are computed and returned
      logger.error('⚠️ Failed to store agent insights in database:', dbError.message);
      // Continue to return insights even if database storage fails
    }

    const insightsAfter = await prisma.agentInsight.findUnique({ where: { sessionId } });
    res.json({
      success: true,
      report: {
        watcher,
        extractor,
        sanity,
        judge: insightsAfter?.judge || null,
        geminiVideoAnalysis: (insightsAfter as any)?.geminiVideoAnalysis || null,
        metrics: {
          promptQuality:  metrics.promptQuality,
          selfReliance:   metrics.selfReliance,
          promptIQ:       metrics.promptIQ,
          promptCount:    metrics.promptCount,
          copyCount:      metrics.copyCount,
          applyCount:     metrics.applyCount,
          totalTokens:    metrics.totalTokens,
          modelSwitches:  metrics.modelSwitches,
          modelBreakdown: metrics.modelBreakdown,
        }
      },
      cached: false,
      computedAt: new Date().toISOString()
    });
  } catch (error: any) {
    logger.error('Error in full-report endpoint:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Re-trigger Gemini video analysis for a submitted session (with debug info)
// POST /api/agents/gemini/:sessionId
router.post('/gemini/:sessionId', async (req: Request, res: Response) => {
  const debug: Record<string, any> = {};
  try {
    const { sessionId } = req.params;
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;

    const hasAccess = await verifySessionAccess(sessionId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // ── Step 1: Check session + assessment ──────────────────────────────────
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { assessment: { include: { company: true } } },
    });
    debug.sessionFound = !!session;
    debug.candidateName = session?.candidateName;
    debug.assessmentId = session?.assessmentId;
    debug.companyName = (session?.assessment as any)?.company?.name;
    debug.jobTitle = (session?.assessment as any)?.jobTitle;
    if (!session) return res.json({ success: false, error: 'Session not found', debug });

    // ── Step 2: Check env vars ───────────────────────────────────────────────
    debug.hasGoogleKey = !!process.env.GOOGLE_AI_API_KEY;
    debug.supabaseUrl = !!process.env.SUPABASE_URL;
    debug.bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';

    // ── Step 3: List screenshare chunks ─────────────────────────────────────
    const { createClient } = await import('@supabase/supabase-js');
    const { sanitizeName } = await import('../lib/storage-utils');
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';
    const companyName = (session.assessment as any)?.company?.name || 'UnknownCompany';
    const jobName = (session.assessment as any)?.jobTitle || (session.assessment as any)?.role || 'UnknownJob';
    const candidateName = session.candidateName || session.sessionCode || 'UnknownCandidate';
    const prefix = ['companies', sanitizeName(companyName), 'jobs', sanitizeName(jobName), sanitizeName(candidateName), 'screenshare'].join('/');
    debug.prefix = prefix;

    const { data: files, error: listError } = await supabase.storage.from(bucket).list(prefix, { limit: 2000 });
    debug.listError = listError?.message;
    debug.rawFileCount = files?.length ?? 0;
    debug.rawFilesSample = files?.slice(0, 5).map(f => f.name);
    const webmChunks = (files || []).filter(f => f.name.endsWith('.webm') && /^chunk_(\d+)(?:_\d+)?\.webm$/.test(f.name));
    debug.webmChunkCount = webmChunks.length;
    debug.webmSample = webmChunks.slice(0, 5).map(f => f.name);

    if (webmChunks.length === 0) {
      return res.json({ success: false, error: 'No .webm chunks found at prefix', debug });
    }

    // ── Step 4: Download first chunk and test ffmpeg ─────────────────────────
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const ffmpegLib = await import('fluent-ffmpeg');
    const ffmpegFn = (ffmpegLib as any).default || ffmpegLib;

    const firstChunk = webmChunks[0];
    const chunkFilePath = `${prefix}/${firstChunk.name}`;
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(chunkFilePath);
    debug.testChunkUrl = urlData.publicUrl;

    // Download first chunk
    let chunkBuf: Buffer | null = null;
    try {
      const cr = await fetch(urlData.publicUrl, { signal: AbortSignal.timeout(20_000) });
      debug.chunkFetchStatus = cr.status;
      if (cr.ok) chunkBuf = Buffer.from(await cr.arrayBuffer());
    } catch (e: any) {
      debug.chunkFetchError = e.message;
    }

    if (!chunkBuf) {
      return res.json({ success: false, error: 'Failed to download first test chunk', debug });
    }
    debug.chunkSize = chunkBuf.byteLength;

    // Write to temp and test ffmpeg
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'));
    const testVideoPath = path.join(tmpDir, 'test.webm');
    const testFramesDir = path.join(tmpDir, 'frames');
    fs.mkdirSync(testFramesDir);
    fs.writeFileSync(testVideoPath, chunkBuf);

    try {
      await new Promise<void>((resolve, reject) => {
        ffmpegFn(testVideoPath)
          .outputOptions(['-vf fps=1/5', '-q:v 5', '-frames:v 3'])
          .output(path.join(testFramesDir, 'frame_%04d.jpg'))
          .on('end', () => resolve())
          .on('error', (e: any) => reject(e))
          .run();
      });
      const frames = fs.readdirSync(testFramesDir).filter((f: string) => f.endsWith('.jpg'));
      debug.ffmpegTest = 'SUCCESS';
      debug.ffmpegFrames = frames.length;
    } catch (e: any) {
      debug.ffmpegTest = 'FAILED';
      debug.ffmpegError = e.message;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return res.json({ success: false, error: 'ffmpeg test failed', debug });
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    // ── Step 5: Test Vertex AI directly ─────────────────────────────────────
    const cryptoLib = await import('crypto');
    const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    debug.hasServiceAccount = !!saJson;

    if (!saJson) {
      return res.json({ success: false, error: 'GOOGLE_SERVICE_ACCOUNT_JSON not set', debug });
    }

    // Get Vertex access token
    let accessToken: string | null = null;
    try {
      const sa = JSON.parse(saJson);
      debug.saProjectId = sa.project_id;
      debug.saEmail = sa.client_email;
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        iss: sa.client_email, sub: sa.client_email,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now, exp: now + 3600,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
      })).toString('base64url');
      const unsigned = `${header}.${payload}`;
      const sign = cryptoLib.createSign('RSA-SHA256');
      sign.update(unsigned);
      const signature = sign.sign(sa.private_key, 'base64url');
      const jwt = `${unsigned}.${signature}`;

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
      });
      debug.tokenStatus = tokenRes.status;
      if (tokenRes.ok) {
        const tokenData = (await tokenRes.json()) as any;
        accessToken = tokenData.access_token;
        debug.gotAccessToken = !!accessToken;
      } else {
        const tokenErr = await tokenRes.text();
        debug.tokenError = tokenErr.slice(0, 200);
        return res.json({ success: false, error: 'Failed to get Vertex access token', debug });
      }
    } catch (e: any) {
      debug.tokenException = e.message;
      return res.json({ success: false, error: 'Exception getting Vertex token', debug });
    }

    // Quick text-only Vertex AI test — try multiple API versions and model names
    const sa2 = JSON.parse(saJson);
    const candidateModels = ['gemini-2.0-flash-001', 'gemini-2.0-flash', 'gemini-1.5-flash-002', 'gemini-1.5-flash'];
    const apiVersions = ['v1', 'v1beta1'];
    let workingModel: string | null = null;
    let workingApiVersion: string | null = null;
    const modelTests: Record<string, any> = {};
    debug.modelTests = modelTests;

    outer:
    for (const apiVer of apiVersions) {
      for (const m of candidateModels) {
        const ep = `https://us-central1-aiplatform.googleapis.com/${apiVer}/projects/${sa2.project_id}/locations/us-central1/publishers/google/models/${m}:generateContent`;
        try {
          const tr = await fetch(ep, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with just the word ok' }] }], generationConfig: { temperature: 0, maxOutputTokens: 5 } }),
            signal: AbortSignal.timeout(15_000),
          });
          modelTests[`${apiVer}/${m}`] = tr.status;
          if (tr.ok) {
            workingModel = m;
            workingApiVersion = apiVer;
            const td = (await tr.json()) as any;
            debug.vertexTestReply = td?.candidates?.[0]?.content?.parts?.[0]?.text;
            debug.vertexTest = 'SUCCESS';
            debug.vertexModel = m;
            debug.vertexApiVersion = apiVer;
            break outer;
          } else {
            const et = await tr.text();
            modelTests[`${apiVer}/${m}_err`] = et.slice(0, 100);
          }
        } catch (e: any) {
          modelTests[`${apiVer}/${m}_exc`] = (e as any).message;
        }
      }
    }

    if (!workingModel) {
      debug.vertexTest = 'FAILED';
      // Don't stop — the service has an AI Studio fallback, try it anyway
      debug.note = 'Vertex AI unavailable — will attempt AI Studio fallback in analyzeSessionVideo';
    }

    // ── Step 6: Try AI Studio key directly if Vertex failed ─────────────────
    if (!workingModel && process.env.GOOGLE_AI_API_KEY) {
      const apiKey = process.env.GOOGLE_AI_API_KEY;
      const testModel = 'gemini-2.0-flash';
      const aiStudioUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${apiKey}`;
      try {
        const atr = await fetch(aiStudioUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with just the word ok' }] }], generationConfig: { temperature: 0, maxOutputTokens: 5 } }),
          signal: AbortSignal.timeout(15_000),
        });
        debug.aiStudioTestStatus = atr.status;
        if (atr.ok) {
          const atd = (await atr.json()) as any;
          debug.aiStudioTestReply = atd?.candidates?.[0]?.content?.parts?.[0]?.text;
          debug.aiStudioTest = 'SUCCESS';
        } else {
          const aterr = await atr.text();
          debug.aiStudioTestError = aterr.slice(0, 200);
          debug.aiStudioTest = 'FAILED';
          // Don't stop — OpenAI fallback will be tried in analyzeSessionVideo
        }
      } catch (e: any) {
        debug.aiStudioTestException = (e as any).message;
        debug.aiStudioTest = 'FAILED';
      }
    }

    // ── Step 7: Test OpenAI if available ────────────────────────────────────
    if (!workingModel && process.env.OPENAI_API_KEY) {
      try {
        const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o', max_tokens: 5, messages: [{ role: 'user', content: 'Reply with just ok' }] }),
          signal: AbortSignal.timeout(15_000),
        });
        debug.openAITestStatus = oaiRes.status;
        if (oaiRes.ok) {
          const oaiData = (await oaiRes.json()) as any;
          debug.openAITestReply = oaiData?.choices?.[0]?.message?.content;
          debug.openAITest = 'SUCCESS';
        } else {
          const oaiErr = await oaiRes.text();
          debug.openAITestError = oaiErr.slice(0, 150);
          debug.openAITest = 'FAILED';
          return res.json({ success: false, error: 'All AI providers failed', debug });
        }
      } catch (e: any) {
        debug.openAITestException = (e as any).message;
        return res.json({ success: false, error: 'OpenAI test threw exception', debug });
      }
    }

    // Now run the full analysis
    const { analyzeSessionVideo } = await import('../services/gemini-video-analysis');
    const result = await analyzeSessionVideo(sessionId);
    debug.analysisResult = result ? 'SUCCESS' : 'NULL';

    if (!result) {
      return res.json({ success: false, error: 'analyzeSessionVideo returned null', debug });
    }

    // ── Step 5: Save to DB ───────────────────────────────────────────────────
    const existing = await prisma.agentInsight.findUnique({ where: { sessionId } });
    if (existing) {
      await prisma.agentInsight.update({
        where: { sessionId },
        data: { geminiVideoAnalysis: result as any, updatedAt: new Date() }
      });
      debug.saved = true;
    } else {
      return res.json({ success: false, error: 'No AgentInsight record found', debug });
    }

    return res.json({ success: true, geminiVideoAnalysis: result, debug });
  } catch (error: any) {
    logger.error('[Gemini Re-trigger] Error:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack?.slice(0, 500), debug });
  }
});

export default router;

