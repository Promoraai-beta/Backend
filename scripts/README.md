# Test User Creation Scripts

## Create Test Users

This script creates test users for all roles (admin, recruiter, candidate) with their profiles and associated data.

### Usage

```bash
# From backend directory
npm run create-test-users

# Or directly with ts-node
npx ts-node scripts/create-test-users.ts
```

### Test Users Created

#### 1. Admin User
- **Email**: `admin@test.com`
- **Password**: `admin123`
- **Role**: `admin`
- **Access**: Full access to all features

#### 2. Recruiter User
- **Email**: `recruiter@test.com`
- **Password**: `recruiter123`
- **Role**: `recruiter`
- **Company**: Test Company
- **Profile**: Senior Recruiter in Talent Acquisition

#### 3. Candidate User
- **Email**: `candidate@test.com`
- **Password**: `candidate123`
- **Role**: `candidate`
- **Profile**: Software Engineer with skills in JavaScript, TypeScript, React, Node.js, Python

#### 4. Recruiter 2
- **Email**: `recruiter2@test.com`
- **Password**: `recruiter123`
- **Role**: `recruiter`
- **Company**: Another Test Company
- **Profile**: Technical Recruiter in HR

#### 5. Candidate 2
- **Email**: `candidate2@test.com`
- **Password**: `candidate123`
- **Role**: `candidate`
- **Profile**: Frontend Developer with skills in React, Vue.js, CSS, HTML

### What Gets Created

1. **Users**: Base user accounts with hashed passwords
2. **Recruiter Profiles**: For recruiter users with company associations
3. **Candidate Profiles**: For candidate users with skills, interests, and bio
4. **Companies**: Test companies for recruiters
5. **All required associations**: Properly linked profiles and companies

### Notes

- The script checks if users already exist and skips them (idempotent)
- Passwords are securely hashed using bcrypt
- All users are ready to use immediately after creation
- You can modify the script to add more test users or change details

### Testing the Application

After running the script, you can:

1. **Login as Admin**: Full access to all features
2. **Login as Recruiter**: Create assessments, view candidates, manage sessions
3. **Login as Candidate**: Take assessments, view results, create self-assessments

### Troubleshooting

If you encounter errors:

1. **Database Connection**: Ensure your database is running and DATABASE_URL is set
2. **Prisma Client**: Run `npm run prisma:generate` if you get Prisma errors
3. **Dependencies**: Ensure all dependencies are installed with `npm install`
4. **Duplicate Users**: The script skips existing users, so it's safe to run multiple times

### Cleanup

To remove test users:

```sql
-- Delete test users (be careful!)
DELETE FROM users WHERE email IN (
  'admin@test.com',
  'recruiter@test.com',
  'candidate@test.com',
  'recruiter2@test.com',
  'candidate2@test.com'
);
```

**Note**: This will also delete associated profiles and data due to cascade deletes.

