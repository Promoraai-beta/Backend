/**
 * Google Sheets Plugin - Backend (provision + evaluate)
 * Template sheet is duplicated per candidate; candidate gets shareable edit link (no login).
 *
 * Auth (use one):
 * - OAuth: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN. Copy goes to this account's Drive (your 2TB). Template must be owned or shared with this account.
 * - Service account: set GOOGLE_SERVICE_ACCOUNT_JSON. Copy goes to service account Drive (limited quota). Template must be shared with service account email.
 */

import type { Plugin, PluginManifest, PluginProvisionResult, PluginEvaluation } from "../plugin-registry";

const manifest: PluginManifest = {
  id: "sheets",
  name: "Google Sheets",
  version: "1.0.0",
  description: "Assessment via Google Sheets (template duplicated per candidate)",
  icon: "📊",
  category: "spreadsheet",
  credentials_required: ["GOOGLE_SERVICE_ACCOUNT_JSON"],
  assessment_types: ["data", "analyst", "product_manager"],
  provision_type: "creates_resource",
  ui: { label: "Open Sheets", opens_in: "new_tab" }
};

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function getServiceAccount(): ServiceAccountKey {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set in .env");
  try {
    const key = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!key.client_email || !key.private_key) throw new Error("Invalid service account JSON");
    return key;
  } catch (e: any) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must be valid JSON with client_email and private_key");
  }
}

/** Prefer OAuth (refresh token) so copy goes to your Drive. Fallback to service account. */
async function getAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken
      }).toString()
    });
    if (!res.ok) throw new Error(`Google OAuth (refresh): ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }

  const key = getServiceAccount();
  const jwt = await import("jsonwebtoken");
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      iss: key.client_email,
      sub: key.client_email,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive"
    },
    key.private_key,
    { algorithm: "RS256" }
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: token
    }).toString()
  });
  if (!res.ok) throw new Error(`Google OAuth: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function provision(
  sessionId: string,
  config: { templateId?: string; sheetsTemplateId?: string; credentials?: Record<string, string> }
): Promise<PluginProvisionResult> {
  const templateId = config.templateId || config.sheetsTemplateId || process.env.SHEETS_TEMPLATE_ID;
  if (!templateId) throw new Error("Sheets: templateId (spreadsheet ID) required. Set SHEETS_TEMPLATE_ID in .env or pass sheetsTemplateId.");
  const token = await getAccessToken();
  const copyRes = await fetch(`https://www.googleapis.com/drive/v3/files/${templateId}/copy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name: `Assessment Sheet ${sessionId.slice(0, 8)}` })
  });
  if (!copyRes.ok) {
    const text = await copyRes.text();
    if (copyRes.status === 404) {
      const key = getServiceAccount();
      throw new Error(`Template spreadsheet not found (404). Share the sheet "${templateId}" with the service account email "${key.client_email}" as Editor.`);
    }
    if (copyRes.status === 403) {
      try {
        const errorData = JSON.parse(text);
        if (errorData.error?.reason === 'storageQuotaExceeded') {
          throw new Error(`Google Drive storage quota exceeded. Free up space in Google Drive or use a different Google account/project with available storage. Service account: ${getServiceAccount().client_email}`);
        }
      } catch {}
    }
    throw new Error(`Drive copy: ${copyRes.status} ${text}`);
  }
  const copyData = (await copyRes.json()) as { id: string };
  const newId = copyData.id;
  // Anyone with the link can edit — no Google sign-in required for candidates
  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${newId}/permissions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type: "anyone",
      role: "writer"
    })
  });
  if (!permRes.ok) {
    const text = await permRes.text();
    throw new Error(`Drive permissions: ${permRes.status} ${text}`);
  }
  const url = `https://docs.google.com/spreadsheets/d/${newId}/edit`;
  return { url, resourceId: newId };
}

/** CellData from Sheets API v4 - userEnteredValue (ExtendedValue) */
interface CellValue {
  stringValue?: string;
  numberValue?: number;
  boolValue?: boolean;
  formulaValue?: string;
}
interface CellData {
  userEnteredValue?: CellValue;
}
interface RowData {
  values?: CellData[];
}

async function analyze(
  resourceId: string,
  credentials: Record<string, string>
): Promise<{ insights: any }> {
  const token = await getAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${resourceId}?fields=properties,sheets(properties,data(rowData(values(userEnteredValue))))`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return { insights: { error: `Sheets API: ${res.status}` } };
  const data = (await res.json()) as {
    properties?: { title?: string };
    sheets?: Array<{ properties?: object; data?: Array<{ rowData?: RowData[] }> }>;
  };

  const cell_values: Array<{ row: number; col: number; value: string | number | boolean; type: "value" | "formula" }> = [];
  const formulas: string[] = [];

  for (const sheet of data.sheets || []) {
    for (const grid of sheet.data || []) {
      const rows = grid.rowData || [];
      rows.forEach((row: RowData, rowIndex: number) => {
        (row.values || []).forEach((cell: CellData, colIndex: number) => {
          const uv = cell.userEnteredValue;
          if (!uv) return;
          const formula = uv.formulaValue;
          const isFormula = !!formula;
          const value: string | number | boolean =
            formula !== undefined
              ? formula
              : uv.stringValue !== undefined
                ? uv.stringValue
                : uv.numberValue !== undefined
                  ? uv.numberValue
                  : uv.boolValue !== undefined
                    ? uv.boolValue
                    : "";
          cell_values.push({
            row: rowIndex + 1,
            col: colIndex + 1,
            value,
            type: isFormula ? "formula" : "value"
          });
          if (isFormula && formula) formulas.push(formula);
        });
      });
    }
  }

  const formulas_list = formulas.slice(0, 20);
  const insights = {
    sheet_count: data.sheets?.length ?? 0,
    cells_filled: cell_values.length,
    cells_edited: cell_values.length,
    formulas_used: formulas.length,
    formulas_list,
    uses_vlookup: formulas.some((f) => /VLOOKUP|HLOOKUP/i.test(f)),
    uses_sum: formulas.some((f) => /SUM/i.test(f)),
    uses_if: formulas.some((f) => /^=IF\b/i.test(f)),
    uses_index_match: formulas.some((f) => /INDEX|MATCH/i.test(f)),
    cell_values,
    last_modified: (data as any).properties?.title,
    captured_at: new Date().toISOString()
  };

  return { insights };
}

async function evaluate(
  resourceId: string,
  allInsights: Array<{ source: string; payload: any }>,
  credentials: Record<string, string>
): Promise<PluginEvaluation> {
  const snapshots = allInsights.filter((i) => i.source === "sheets");
  const latest = snapshots[snapshots.length - 1]?.payload;
  if (!latest || latest.error) {
    return { score: 0, notes: latest?.error || "No sheets activity", strengths: [], gaps: [] };
  }
  const cellsFilled = latest.cells_filled ?? latest.cells_edited ?? 0;
  const formulasUsed = latest.formulas_used ?? 0;
  const strengths: string[] = [];
  const gaps: string[] = [];
  let score = 5;
  if (cellsFilled > 10) {
    score += 2;
    strengths.push("Good data entry");
  }
  if (latest.sheet_count > 1) {
    score += 1;
    strengths.push("Multiple sheets");
  }
  if (formulasUsed > 0) {
    score += 1;
    strengths.push(`${formulasUsed} formula(s)`);
  }
  if (latest.uses_vlookup) strengths.push("Used VLOOKUP/HLOOKUP");
  if (latest.uses_sum) strengths.push("Used SUM");
  if (latest.uses_if) strengths.push("Used IF");
  if (latest.uses_index_match) strengths.push("Used INDEX/MATCH");
  if (cellsFilled < 5) gaps.push("More data entry expected");
  if (formulasUsed === 0 && cellsFilled > 0) gaps.push("Consider using formulas");
  score = Math.min(score, 10);
  const notes = [
    `${cellsFilled} cells`,
    `${latest.sheet_count ?? 0} sheet(s)`,
    formulasUsed ? `${formulasUsed} formula(s)` : null
  ]
    .filter(Boolean)
    .join(", ");
  return {
    score,
    notes: notes || "Minimal sheets activity",
    strengths: strengths.length ? strengths : [],
    gaps
  };
}

const plugin: Plugin = {
  id: manifest.id,
  name: manifest.name,
  manifest,
  provision,
  analyze,
  evaluate
};

export default plugin;
