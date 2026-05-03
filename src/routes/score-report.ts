import { Router, Request, Response } from 'express';
import { scoreWithManifest } from '../mcp/servers/serverC';
import { prisma } from '../lib/prisma';
import { authenticate, checkSessionOwnership } from '../middleware/rbac';
import { logger } from '../lib/logger';

const router = Router();

/**
 * GET /api/score-report/:sessionId
 * Generates a comprehensive, manifest-aware score report for a session.
 *
 * Flow:
 * 1. Load session + assessment (including assessmentManifest from the template).
 * 2. Call Server C `score_with_manifest` with the manifest.
 * 3. Optionally run the legacy agents in parallel for behavioral context.
 * 4. Return a unified score report.
 */
router.get('/:sessionId', authenticate, checkSessionOwnership, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    // 1. Load session and linked assessment
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        assessment: {
          include: { templateRef: true },
        },
        submissions: { orderBy: { submittedAt: 'desc' }, take: 1 },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // 2. Extract manifest from assessment template
    let manifest: Record<string, any> | null = null;

    // Try template ref first (new path — templateSpec is the JSONB column)
    if (session.assessment?.templateRef?.templateSpec) {
      const templateSpec = session.assessment.templateRef.templateSpec as any;
      manifest = templateSpec?.assessmentManifest || null;
    }

    // Fall back to inline template (legacy path)
    if (!manifest && session.assessment?.template) {
      const inlineTemplate = session.assessment.template as any;
      manifest = inlineTemplate?.templateSpec?.assessmentManifest
        || inlineTemplate?.assessmentManifest
        || null;
    }

    // 3. Get final code — try multiple sources
    let finalFiles: Record<string, string> | undefined;

    // Source 1: session.finalCode (set by /end or /submit-files)
    if (session.finalCode) {
      try {
        const parsed = JSON.parse(session.finalCode);
        if (typeof parsed === 'object' && parsed !== null) {
          finalFiles = parsed;
        }
      } catch {
        finalFiles = { main: session.finalCode };
      }
    }

    // Source 2: latest submission code (for code challenges)
    if (!finalFiles && session.submissions && session.submissions.length > 0) {
      const latestSubmission = session.submissions[0]; // already ordered desc
      if (latestSubmission.code) {
        try {
          const parsed = JSON.parse(latestSubmission.code);
          if (typeof parsed === 'object' && parsed !== null) {
            finalFiles = parsed;
          }
        } catch {
          finalFiles = { main: latestSubmission.code };
        }
      }
    }

    // Source 3: latest code snapshot (fallback)
    if (!finalFiles) {
      const latestSnapshot = await prisma.codeSnapshot.findFirst({
        where: { sessionId },
        orderBy: { timestamp: 'desc' },
      });
      if (latestSnapshot?.code) {
        try {
          const parsed = JSON.parse(latestSnapshot.code);
          if (typeof parsed === 'object' && parsed !== null) {
            finalFiles = parsed;
          }
        } catch {
          finalFiles = { main: latestSnapshot.code };
        }
      }
    }

    // 4. If we have a manifest, use manifest-aware scoring
    let manifestScore: any = null;
    if (manifest) {
      try {
        manifestScore = await scoreWithManifest(sessionId, manifest, finalFiles);
      } catch (err: any) {
        logger.error(`Manifest scoring failed for ${sessionId}: ${err.message}`);
      }
    }

    // 5. Read pre-computed insights from DB (stored during live session + post-session pipeline)
    const insights = await prisma.agentInsight.findUnique({ where: { sessionId } });
    const watcher  = (insights?.watcher  as any) ?? null;
    const analysis = (insights?.extractor as any) ?? null;

    // 6. Build unified response
    const report: Record<string, any> = {
      sessionId,
      assessmentType: manifest?.assessmentType || 'generic',
      role: manifest?.role || session.assessment?.role || 'unknown',
      hasManifest: !!manifest,
      generatedAt: new Date().toISOString(),
    };

    if (manifestScore?.success) {
      report.scorerVersion = manifestScore.scorerVersion || 'v1';
      report.overallScore = manifestScore.overallScore;
      report.dimensionScores = manifestScore.dimensionScores;

      // Backward-compatible fields
      report.bugDiscovery = manifestScore.bugDiscovery;
      report.checkpointResults = manifestScore.checkpointResults;
      report.behaviorAnalysis = manifestScore.behaviorAnalysis;
      report.codeQuality = manifestScore.codeQuality;
      report.strengths = manifestScore.strengths;
      report.weaknesses = manifestScore.weaknesses;
      report.confidence = manifestScore.confidence;
      report.explanation = manifestScore.explanation;

      // Deep analysis (v2 fields)
      if (manifestScore.scorerVersion === 'v2') {
        report.bugNarratives = manifestScore.bugNarratives;
        report.fluencyAnalysis = manifestScore.fluencyAnalysis;
        report.responseAnalysis = manifestScore.responseAnalysis;
        report.terminalAnalysis = manifestScore.terminalAnalysis;
        report.codeOrigins = manifestScore.codeOrigins;
        report.fileChangeMap = manifestScore.fileChangeMap;
      }
    } else {
      // Fallback: provide behavioral-only scoring
      report.overallScore = null;
      report.fallbackReason = manifest
        ? 'Manifest scoring failed — using behavioral analysis only'
        : 'No manifest available — using behavioral analysis only';
      report.behaviorAnalysis = analysis;
    }

    report.violations = (watcher as any)?.violations || [];
    report.riskScore = (watcher as any)?.riskScore || 0;

    // Post-session orchestrator verdict + Gemini video analysis (pre-computed, just read from DB)
    report.judge = insights?.judge || null;
    report.geminiVideoAnalysis = (insights as any)?.geminiVideoAnalysis || null;
    report.sanity = insights?.sanity || null;

    // 7. Candidate-friendly summary
    report.candidateSummary = _buildCandidateSummary(report);

    return res.json(report);
  } catch (error: any) {
    logger.error(`Score report error: ${error.message}`);
    return res.status(500).json({ error: 'Failed to generate score report' });
  }
});

/**
 * Build a human-readable summary for the candidate.
 * v2: includes fluency insights, testing behavior, and per-bug stories.
 */
function _buildCandidateSummary(report: Record<string, any>): Record<string, any> {
  const summary: Record<string, any> = {
    scoreAvailable: report.overallScore !== null && report.overallScore !== undefined,
  };

  if (!summary.scoreAvailable) {
    summary.message = 'Detailed scoring is not available for this assessment type.';
    return summary;
  }

  const score = report.overallScore as number;
  summary.overallScore = score;
  summary.grade = score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Needs Improvement' : 'Below Expectations';

  // Bug discovery feedback
  const bugs = report.bugDiscovery;
  if (bugs) {
    summary.bugsFound = `${bugs.bugsFound}/${bugs.totalBugs} issues identified`;
    summary.bugsFixed = `${bugs.bugsFixed}/${bugs.totalBugs} issues fixed`;
  }

  // Strengths and weaknesses
  summary.strengths = (report.strengths || []).map((s: string) => s.replace(/_/g, ' '));
  summary.areasForImprovement = (report.weaknesses || []).map((w: string) => w.replace(/_/g, ' '));

  // AI usage assessment (v2 — richer labels)
  const behavior = report.behaviorAnalysis;
  if (behavior?.assessment) {
    const assessmentLabels: Record<string, string> = {
      healthy_usage: 'You demonstrated healthy AI usage — validating and modifying AI suggestions.',
      moderate_reliance: 'You showed moderate reliance on AI — consider validating more before accepting.',
      high_reliance: 'You showed high reliance on AI — try to verify and adapt AI output more critically.',
    };
    summary.aiUsage = assessmentLabels[behavior.assessment] || behavior.assessment;
  }

  // v2 fluency insights
  const fluency = report.fluencyAnalysis;
  if (fluency?.chainSummary) {
    const chain = fluency.chainSummary;
    summary.fluencyScore = chain.fluencyScore;

    if (chain.verifiedRate > 0.3) {
      summary.fluencyHighlight = 'You consistently verified AI output before committing — strong practice.';
    } else if (chain.blindPasteRate > 0.4) {
      summary.fluencyHighlight = 'You tended to paste AI output without verifying — try running tests after changes.';
    }
  }

  // v2 temporal progression
  if (fluency?.temporalProgression?.progression === 'improving') {
    summary.progressionNote = 'Your prompts improved in quality over the session — great adaptability.';
  }

  // v2 testing behavior
  const terminal = report.terminalAnalysis;
  if (terminal?.testBehavior) {
    const testAssess = terminal.testBehavior.assessment;
    const testLabels: Record<string, string> = {
      test_driven: 'Excellent — you used a test-driven approach.',
      iterative_testing: 'Good — you tested iteratively after changes.',
      occasional_testing: 'You ran tests occasionally — more frequent testing would improve results.',
      never_tested: 'You did not run any tests — running tests helps validate your changes.',
    };
    if (testLabels[testAssess]) {
      summary.testingFeedback = testLabels[testAssess];
    }
  }

  // v2 per-bug narrative summaries (top 3)
  const narratives = report.bugNarratives;
  if (narratives) {
    const bugStories: Array<{ issue: string; result: string }> = [];
    for (const [bugId, narrative] of Object.entries(narratives as Record<string, any>)) {
      if (bugStories.length >= 3) break;
      bugStories.push({
        issue: (narrative.description || bugId).replace(/bug_/g, '').replace(/_/g, ' '),
        result: narrative.narrativeText || 'No details available.',
      });
    }
    summary.bugStories = bugStories;
  }

  // Code origin
  const origins = report.codeOrigins;
  if (origins) {
    const ratio = origins.aiCodeRatio;
    if (ratio > 0.7) {
      summary.codeOriginNote = 'Most of your code came from AI — consider writing more independently.';
    } else if (ratio < 0.3) {
      summary.codeOriginNote = 'Most of your code was self-written — you used AI primarily for reference.';
    } else {
      summary.codeOriginNote = 'Balanced mix of self-written and AI-assisted code.';
    }
  }

  return summary;
}

export default router;
