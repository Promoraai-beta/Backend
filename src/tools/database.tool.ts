/**
 * Database Tool
 *
 * Activates when the scenario's generated codebase has SQLAlchemy models or
 * the recruiter explicitly selected the 'database' component.
 *
 * Content is derived from the ACTUAL models.py / schema in the generated
 * fileStructure — not from a generic description. This keeps it connected
 * to the same scenario as the code server tab.
 */

import type { AssessmentTool, ScenarioContext, ToolContent, ToolProvisionResult } from './types';

// Database file patterns that indicate a DB component is present
const DB_FILE_PATTERNS = [
  'backend/models.py',
  'data.db',
  'db.js',
  'database.js',
  'schema.sql',
  'migrations/',
];

function extractSchemaContext(fileStructure: Record<string, string>): {
  modelNames: string[];
  tableCount: number;
  hasIndex: boolean;
  modelsFile: string | null;
} {
  const modelsKey = Object.keys(fileStructure).find(
    k => k === 'backend/models.py' || k.endsWith('/models.py')
  );
  if (!modelsKey) return { modelNames: [], tableCount: 0, hasIndex: false, modelsFile: null };

  const content = fileStructure[modelsKey];

  // Extract SQLAlchemy model class names
  const modelMatches = content.match(/class\s+(\w+)\s*\([^)]*(?:db\.Model|Base)\s*\)/g) ?? [];
  const modelNames = modelMatches.map(m => m.match(/class\s+(\w+)/)?.[1] ?? '').filter(Boolean);

  // Detect if there's an index definition
  const hasIndex = content.includes('db.Index(') || content.includes('Index(');

  return {
    modelNames,
    tableCount: modelNames.length,
    hasIndex,
    modelsFile: modelsKey,
  };
}

function extractDatabaseBugs(intentionalIssues: ScenarioContext['intentionalIssues']): typeof intentionalIssues {
  return intentionalIssues.filter(issue =>
    issue.category === 'data_layer' ||
    issue.category === 'performance' ||
    (issue.file && (issue.file.includes('models.py') || issue.file.includes('schema')))
  );
}

export const databaseTool: AssessmentTool = {
  id:      'database',
  label:   'Database',
  metaKey: 'hasDatabase',

  detect(ctx: ScenarioContext): boolean {
    if (ctx.components.includes('database')) return true;

    const files = Object.keys(ctx.fileStructure);
    return DB_FILE_PATTERNS.some(pattern =>
      files.some(f => f.endsWith(pattern) || f.includes(pattern))
    );
  },

  generateContent(ctx: ScenarioContext): ToolContent {
    const schema = extractSchemaContext(ctx.fileStructure);
    const dbBugs = extractDatabaseBugs(ctx.intentionalIssues);

    // Build a task description that references the ACTUAL tables and issues
    // from this specific scenario — not a generic "write a query" prompt
    const taskLines: string[] = [];

    if (schema.modelNames.length > 0) {
      taskLines.push(
        `Inspect the database schema for: ${schema.modelNames.join(', ')}.`
      );
    }

    if (!schema.hasIndex && schema.modelNames.length > 0) {
      taskLines.push(
        `Identify the missing index on the most performance-critical query ` +
        `(run EXPLAIN ANALYZE to find it).`
      );
    }

    dbBugs.forEach(issue => {
      taskLines.push(issue.description);
    });

    const taskDescription = taskLines.length > 0
      ? taskLines.join('\n')
      : `Inspect the database schema and fix any data-layer issues in the codebase.`;

    return {
      toolId: 'database',
      payload: {
        modelNames:      schema.modelNames,
        tableCount:      schema.tableCount,
        hasIndex:        schema.hasIndex,
        modelsFile:      schema.modelsFile,
        dbBugCount:      dbBugs.length,
        taskDescription,
      },
    };
  },

  // No provisionAsync — pgweb is started as part of the Docker container
  // provisioned at invite time. The URL comes from containerInfo.

  enrichResponse(
    response: Record<string, any>,
    content:  ToolContent,
  ): void {
    if (!response.assessmentMeta) response.assessmentMeta = {};
    response.assessmentMeta.hasDatabase  = true;
    response.assessmentMeta.tableCount   = content.payload.tableCount;
    response.assessmentMeta.modelNames   = content.payload.modelNames;
    // pgwebUrl is populated from containerInfo by sessions.ts — not here
  },
};
