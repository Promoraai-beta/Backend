# Prisma Database Setup Guide

## Issue Found

The Prisma migration was not working because:
1. **Database already had old tables** from a previous schema
2. **`prisma db pull` overwrote the schema** with the old database structure
3. **Duplicate fields** were created (e.g., `sessionCode` appeared twice)
4. **Missing new models** (User, CandidateProfile, RecruiterProfile, Company)

## Solution Applied

### 1. Fixed Schema
- Removed duplicate fields
- Added all required models (User, CandidateProfile, RecruiterProfile, Company)
- Added missing fields (`companyId`, `createdBy`, `candidateId`)
- Validated schema structure

### 2. Synced Database
Used `prisma db push` to sync the schema with the database:
```bash
npx prisma db push --accept-data-loss
```

This approach:
- ✅ Works for development
- ✅ Automatically creates/updates tables
- ✅ No migration files needed (faster for dev)

## For Production

For production, use proper migrations:

```bash
# Create a migration
npx prisma migrate dev --name add_user_authentication

# Apply migrations
npx prisma migrate deploy
```

## Important Notes

### ⚠️ Don't Run `prisma db pull` After Schema Changes

If you modify the schema and push it with `db push`, **do NOT** run `db pull` afterward. It will:
- Overwrite your schema with the database structure
- Lose your schema customizations
- Create duplicate fields

### ✅ Recommended Workflow

1. **Modify schema.prisma** directly
2. **Validate**: `npx prisma validate`
3. **Push changes**: `npx prisma db push`
4. **Generate client**: `npx prisma generate` (auto-run by push)

### ✅ If You Need to Pull Existing Database

If you need to pull an existing database structure:

1. **Backup your schema first**:
   ```bash
   cp prisma/schema.prisma prisma/schema.prisma.backup
   ```

2. **Pull database**:
   ```bash
   npx prisma db pull
   ```

3. **Manually merge** changes from backup if needed

## Current Database Status

✅ **Database is synced and working**
- All tables created
- User authentication working
- Session creation working
- All relationships properly set up

## Test Database Connection

```bash
# Test registration
curl -X POST http://localhost:5001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email":"test@example.com",
    "password":"Test1234",
    "name":"Test User",
    "role":"candidate"
  }'

# Test session creation
curl -X POST http://localhost:5001/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "candidate_name":"Test",
    "candidate_email":"test@example.com",
    "time_limit":3600
  }'
```

## Troubleshooting

### Issue: "Table does not exist"
**Solution**: Run `npx prisma db push`

### Issue: "Field already defined"
**Solution**: Check for duplicate fields in schema.prisma

### Issue: "Migration conflicts"
**Solution**: Use `npx prisma migrate reset` (⚠️ deletes all data) or `npx prisma db push --force-reset`

### Issue: Schema out of sync
**Solution**: 
1. Check schema.prisma for errors: `npx prisma validate`
2. Sync: `npx prisma db push`
3. Regenerate client: `npx prisma generate`

## Database Models

Current models in the database:
- ✅ User (authentication)
- ✅ CandidateProfile
- ✅ RecruiterProfile  
- ✅ Company
- ✅ Assessment
- ✅ Session
- ✅ CodeSnapshot
- ✅ Event
- ✅ VideoChunk
- ✅ Submission
- ✅ AiInteraction

