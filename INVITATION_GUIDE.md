# Recruiter Invitation System

## Overview

Recruiter registration is now **invitation-only** to prevent fake accounts. Only candidates can register publicly.

## How It Works

1. **Candidates**: Can register publicly at `/register`
2. **Recruiters**: Must use invitation links sent manually from the backend
3. **Login**: Single login page that redirects based on role (recruiter → `/dashboard`, candidate → `/candidate/assessments`)

## Creating Invitations

### Method 1: Using the Script (Recommended)

```bash
cd backend
npx ts-node scripts/create-invitation.ts [email] [companyName] [expiresInDays]
```

**Examples:**
```bash
# Create invitation for specific email
npx ts-node scripts/create-invitation.ts recruiter@company.com "Acme Inc" 30

# Create open invitation (no email restriction)
npx ts-node scripts/create-invitation.ts "" "Tech Corp" 30

# Create invitation without company
npx ts-node scripts/create-invitation.ts recruiter@company.com "" 30
```

### Method 2: Using the API (Requires Authentication)

```bash
# Get your JWT token first (login as existing recruiter)
TOKEN="your_jwt_token_here"

# Create invitation
curl -X POST http://localhost:5001/api/invitations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "recruiter@company.com",
    "companyName": "Acme Inc",
    "expiresInDays": 30
  }'
```

## Invitation Link Format

Invitations are accessed via:
```
http://localhost:3000/invite/{token}
```

The token is a 64-character hex string generated using `crypto.randomBytes(32)`.

## Database Schema

```prisma
model Invitation {
  id          String    @id @default(uuid())
  token       String    @unique
  email       String?   // Optional: specific email invitation
  companyId   String?   // Link to existing company
  companyName String?   // Company name if company doesn't exist yet
  role        String    @default("recruiter")
  usedBy      String?   // User ID who used the invitation
  usedAt      DateTime? // When invitation was used
  expiresAt   DateTime? // Invitation expiry date
  createdAt   DateTime  @default(now())
  createdBy   String?   // User ID of admin who created invitation
}
```

## API Endpoints

### POST /api/invitations
Create a new invitation (requires recruiter authentication)
- Body: `{ email?, companyName?, companyId?, expiresInDays? }`
- Returns: `{ success: true, data: { invitation: { token, invitationUrl, ... } } }`

### GET /api/invitations/:token
Get invitation details (public)
- Returns: `{ success: true, data: { token, email, companyName, expiresAt } }`

### POST /api/invitations/:token/accept
Accept invitation and create recruiter account (public)
- Body: `{ email, password, name, company? }`
- Returns: `{ success: true, data: { user, token } }`

## Security Features

1. **Token Validation**: Unique tokens prevent guessing
2. **Expiry Dates**: Invitations expire after set number of days
3. **Single Use**: Once used, invitation cannot be reused
4. **Email Validation**: If invitation has specific email, only that email can use it
5. **Company Linking**: Automatically links recruiter to company

## Frontend Pages

- `/register` - Candidate registration only
- `/login` - Single login page (redirects based on role)
- `/invite/[token]` - Recruiter invitation acceptance page
- `/dashboard` - Recruiter dashboard (requires recruiter role)
- `/candidate/assessments` - Candidate dashboard (requires candidate role)

## Testing

### Test Candidate Registration
```bash
curl -X POST http://localhost:5001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "candidate@example.com",
    "password": "Test1234",
    "name": "Test Candidate",
    "role": "candidate"
  }'
```

### Test Recruiter Registration (Should Fail)
```bash
curl -X POST http://localhost:5001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "recruiter@example.com",
    "password": "Test1234",
    "name": "Test Recruiter",
    "role": "recruiter"
  }'
# Should return: {"success": false, "error": "Recruiter registration is invitation-only..."}
```

### Test Invitation Creation and Acceptance
```bash
# 1. Create invitation
npx ts-node scripts/create-invitation.ts test@example.com "Test Company" 30

# 2. Get invitation details
curl http://localhost:5001/api/invitations/{token}

# 3. Accept invitation
curl -X POST http://localhost:5001/api/invitations/{token}/accept \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test1234",
    "name": "Test Recruiter"
  }'
```

## Environment Variables

Add to `.env`:
```env
FRONTEND_URL=http://localhost:3000
JWT_SECRET=your-secret-key-change-in-production
```

## Next Steps

1. Create invitations manually for existing recruiters
2. Send invitation links via email or other secure channels
3. Monitor invitation usage in the database
4. Consider adding an admin dashboard for managing invitations

