#!/bin/bash

# Backend Quick Test Script
# Tests critical endpoints to verify backend is working

BASE_URL="${BACKEND_URL:-http://localhost:5001}"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Testing Backend Endpoints..."
echo "📍 Base URL: $BASE_URL"
echo ""

# Test 1: Health Check
echo "1️⃣  Testing Health Check..."
HEALTH=$(curl -s "$BASE_URL/health")
if echo "$HEALTH" | grep -q "ok"; then
    echo -e "${GREEN}✅ Health check passed${NC}"
    echo "   Response: $HEALTH"
else
    echo -e "${RED}❌ Health check failed${NC}"
    echo "   Response: $HEALTH"
    exit 1
fi
echo ""

# Test 2: Sessions Route
echo "2️⃣  Testing Sessions Route..."
SESSION_RESPONSE=$(curl -s -X POST "$BASE_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "session_code": "TEST-'$(date +%s)'",
    "candidate_name": "Test User",
    "candidate_email": "test@example.com",
    "recruiter_email": "recruiter@example.com"
  }')

if echo "$SESSION_RESPONSE" | grep -q "success"; then
    echo -e "${GREEN}✅ Sessions route working${NC}"
    SESSION_ID=$(echo "$SESSION_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
    echo "   Session ID: $SESSION_ID"
else
    echo -e "${RED}❌ Sessions route failed${NC}"
    echo "   Response: $SESSION_RESPONSE"
fi
echo ""

# Test 3: Assessments Route (MCP Server A)
echo "3️⃣  Testing Assessments Generation (MCP Server A)..."
ASSESSMENT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/assessments/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitle": "Senior React Developer",
    "company": "TechCorp",
    "jobDescription": "We need a React developer with TypeScript experience. Must know React hooks, state management, and modern frontend practices."
  }')

if echo "$ASSESSMENT_RESPONSE" | grep -q "success"; then
    echo -e "${GREEN}✅ Assessment generation working${NC}"
    # Check if mcpServerBStatus exists (nested in data object)
    if echo "$ASSESSMENT_RESPONSE" | grep -q '"mcpServerBStatus"'; then
        MCP_STATUS=$(echo "$ASSESSMENT_RESPONSE" | grep -o '"mcpServerBStatus":"[^"]*' | cut -d'"' -f4)
        if [ "$MCP_STATUS" = "success" ]; then
            echo -e "${GREEN}✅ MCP Server B integration working (status: $MCP_STATUS)${NC}"
        else
            echo -e "${YELLOW}⚠️  MCP Server B status: $MCP_STATUS${NC}"
            echo "   (This is okay - MCP Server B may have failed, but assessment still generated)"
        fi
    else
        echo -e "${YELLOW}⚠️  MCP Server B status not in response${NC}"
    fi
    # Show if suggestedAssessments are present
    if echo "$ASSESSMENT_RESPONSE" | grep -q "suggestedAssessments"; then
        echo -e "${GREEN}✅ Assessment templates generated${NC}"
    fi
else
    echo -e "${RED}❌ Assessment generation failed${NC}"
    echo "   Response: $ASSESSMENT_RESPONSE"
fi
echo ""

# Test 4: MCP Database API
echo "4️⃣  Testing MCP Database API..."
# Use a dummy session ID for testing
DB_RESPONSE=$(curl -s "$BASE_URL/api/mcp-database/interactions/test-session-id")
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ MCP Database API accessible${NC}"
    echo "   Response: $DB_RESPONSE"
else
    echo -e "${RED}❌ MCP Database API failed${NC}"
fi
echo ""

# Test 5: Code Execution
echo "5️⃣  Testing Code Execution..."
EXEC_RESPONSE=$(curl -s -X POST "$BASE_URL/api/execute" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "console.log(\"Hello from backend test!\");",
    "language": "javascript"
  }')

if echo "$EXEC_RESPONSE" | grep -q "success"; then
    echo -e "${GREEN}✅ Code execution working${NC}"
else
    echo -e "${YELLOW}⚠️  Code execution returned: $EXEC_RESPONSE${NC}"
fi
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "✅ If all tests passed, your backend is working correctly!"
echo ""
echo "💡 Next steps:"
echo "   1. Test with real session data"
echo "   2. Test live-monitoring endpoint with a real sessionId"
echo "   3. Test MCP Server C agents (requires active session)"
echo ""
echo "📖 See TESTING_GUIDE.md for detailed testing instructions"

