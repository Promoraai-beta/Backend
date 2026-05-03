#!/usr/bin/env bash
# Test the full Sheets insight loop:
# 1. POST refresh-sheets-insight (runs analyze + saves to mcp_insights)
# 2. GET mcp-insights?source=sheets
# Use sandbox session ID from test-assessment-azure.
set -e
SESSION_ID="${1:-a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d}"
BASE="${BACKEND_URL:-http://localhost:5001}"

echo "Session ID: $SESSION_ID"
echo "Backend:   $BASE"
echo ""

echo "1. POST /api/sessions/:id/refresh-sheets-insight"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/sessions/$SESSION_ID/refresh-sheets-insight" -H "Content-Type: application/json")
HTTP_CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "   Status: $HTTP_CODE OK"
  echo "   Response: $BODY"
  echo ""
  echo "2. GET /api/sessions/:id/mcp-insights?source=sheets"
  curl -s "$BASE/api/sessions/$SESSION_ID/mcp-insights?source=sheets" | head -c 800
  echo ""
  echo ""
  echo "Done. Check DB: SELECT * FROM mcp_insights WHERE session_id = '$SESSION_ID' AND source = 'sheets';"
else
  echo "   Status: $HTTP_CODE"
  echo "   Response: $BODY"
  if [ "$HTTP_CODE" = "400" ]; then
    echo ""
    echo "Tip: Provision a sheet first: open /test-assessment-azure -> Sheets tab -> Open Google Sheet, then edit the sheet and run this script again."
  fi
  exit 1
fi
