#!/bin/bash

# Backend API Test Script
# Tests basic functionality of the backend

BASE_URL="http://localhost:5001"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Backend API Test Suite ===${NC}\n"

# Test 1: Health Check
echo -e "${YELLOW}Test 1: Health Check${NC}"
HEALTH=$(curl -s "$BASE_URL/health")
if echo "$HEALTH" | grep -q "ok"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo "Response: $HEALTH"
else
    echo -e "${RED}✗ Health check failed${NC}"
    echo "Response: $HEALTH"
fi
echo ""

# Test 2: Register User
echo -e "${YELLOW}Test 2: User Registration${NC}"
REGISTER_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/register" \
    -H "Content-Type: application/json" \
    -d '{
        "email":"testuser_'$(date +%s)'@example.com",
        "password":"Test1234",
        "name":"Test User",
        "role":"candidate"
    }')
if echo "$REGISTER_RESPONSE" | grep -q "success"; then
    echo -e "${GREEN}✓ Registration successful${NC}"
    TOKEN=$(echo "$REGISTER_RESPONSE" | jq -r '.data.token // empty')
    if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
        echo -e "${GREEN}✓ Token received${NC}"
        echo "Token: ${TOKEN:0:50}..."
    fi
else
    echo -e "${RED}✗ Registration failed${NC}"
    echo "Response: $REGISTER_RESPONSE"
fi
echo ""

# Test 3: Code Execution (JavaScript)
echo -e "${YELLOW}Test 3: Code Execution${NC}"
EXECUTE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/execute" \
    -H "Content-Type: application/json" \
    -d '{
        "code":"console.log(\"Hello from backend!\");",
        "language":"javascript"
    }')
if echo "$EXECUTE_RESPONSE" | grep -q "success"; then
    echo -e "${GREEN}✓ Code execution successful${NC}"
    OUTPUT=$(echo "$EXECUTE_RESPONSE" | jq -r '.result.output // empty')
    if [ -n "$OUTPUT" ]; then
        echo "Output: $OUTPUT"
    fi
else
    echo -e "${RED}✗ Code execution failed${NC}"
    echo "Response: $EXECUTE_RESPONSE"
fi
echo ""

# Test 4: Session Creation
echo -e "${YELLOW}Test 4: Session Creation${NC}"
SESSION_RESPONSE=$(curl -s -X POST "$BASE_URL/api/sessions" \
    -H "Content-Type: application/json" \
    -d '{
        "candidate_name":"Test Candidate",
        "candidate_email":"test@example.com",
        "time_limit":3600
    }')
if echo "$SESSION_RESPONSE" | grep -q "success"; then
    echo -e "${GREEN}✓ Session creation successful${NC}"
    SESSION_CODE=$(echo "$SESSION_RESPONSE" | jq -r '.data.sessionCode // empty')
    if [ -n "$SESSION_CODE" ] && [ "$SESSION_CODE" != "null" ]; then
        echo -e "${GREEN}✓ Session code generated: $SESSION_CODE${NC}"
    fi
else
    echo -e "${RED}✗ Session creation failed${NC}"
    echo "Response: $SESSION_RESPONSE"
fi
echo ""

# Test 5: Rate Limiting (Auth)
echo -e "${YELLOW}Test 5: Rate Limiting (Authentication)${NC}"
echo "Making 6 authentication attempts (limit is 5)..."
RATE_LIMIT_HIT=false
for i in {1..6}; do
    RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/login" \
        -H "Content-Type: application/json" \
        -d '{"email":"test@example.com","password":"wrong"}')
    if echo "$RESPONSE" | grep -q "Too many"; then
        echo -e "${GREEN}✓ Rate limiting working (attempt $i)${NC}"
        RATE_LIMIT_HIT=true
        break
    fi
    sleep 0.5
done
if [ "$RATE_LIMIT_HIT" = false ]; then
    echo -e "${YELLOW}⚠ Rate limiting not triggered (may need more attempts or time)${NC}"
fi
echo ""

# Test 6: Input Validation
echo -e "${YELLOW}Test 6: Input Validation${NC}"
VALIDATION_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/register" \
    -H "Content-Type: application/json" \
    -d '{
        "email":"invalid-email",
        "password":"weak",
        "name":"",
        "role":"invalid"
    }')
if echo "$VALIDATION_RESPONSE" | grep -q "Validation failed\|Invalid\|required"; then
    echo -e "${GREEN}✓ Input validation working${NC}"
    echo "Response: $(echo "$VALIDATION_RESPONSE" | jq -r '.error // .details[0].msg // .' | head -1)"
else
    echo -e "${RED}✗ Input validation may not be working${NC}"
    echo "Response: $VALIDATION_RESPONSE"
fi
echo ""

# Test 7: Security Headers
echo -e "${YELLOW}Test 7: Security Headers${NC}"
HEADERS=$(curl -s -I "$BASE_URL/health")
if echo "$HEADERS" | grep -q "X-Frame-Options"; then
    echo -e "${GREEN}✓ Security headers present${NC}"
    echo "$HEADERS" | grep -E "X-Frame-Options|X-Content-Type-Options|X-XSS-Protection"
else
    echo -e "${YELLOW}⚠ Security headers not detected${NC}"
fi
echo ""

echo -e "${YELLOW}=== Test Suite Complete ===${NC}"

