/**
 * Script to create test users for all roles (admin, recruiter, candidate)
 * 
 * Usage:
 *   npx ts-node scripts/create-test-users.ts
 * 
 * Or compile and run:
 *   npm run build
 *   node dist/scripts/create-test-users.js
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Test users configuration
const TEST_USERS = [
  {
    email: 'admin@test.com',
    password: 'admin123',
    name: 'Admin User',
    role: 'admin' as const,
  },
  {
    email: 'recruiter@test.com',
    password: 'recruiter123',
    name: 'Recruiter User',
    role: 'recruiter' as const,
    company: {
      name: 'Test Company',
      industry: 'Technology',
      size: '100-500 employees',
      location: 'San Francisco, CA',
      website: 'https://testcompany.com',
      description: 'A test company for development and testing',
    },
    recruiterProfile: {
      position: 'Senior Recruiter',
      department: 'Talent Acquisition',
    },
  },
  {
    email: 'candidate@test.com',
    password: 'candidate123',
    name: 'Candidate User',
    role: 'candidate' as const,
    candidateProfile: {
      title: 'Software Engineer',
      location: 'New York, NY',
      bio: 'Experienced software engineer with a passion for building scalable applications.',
      skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'Python'],
      interests: ['Frontend Development', 'Full Stack Development'],
      targetRole: 'Senior Software Engineer',
      level: 'Intermediate',
    },
  },
  // Additional test users
  {
    email: 'recruiter2@test.com',
    password: 'recruiter123',
    name: 'Recruiter 2',
    role: 'recruiter' as const,
    company: {
      name: 'Another Test Company',
      industry: 'Finance',
      size: '50-100 employees',
      location: 'New York, NY',
    },
    recruiterProfile: {
      position: 'Technical Recruiter',
      department: 'HR',
    },
  },
  {
    email: 'candidate2@test.com',
    password: 'candidate123',
    name: 'Candidate 2',
    role: 'candidate' as const,
    candidateProfile: {
      title: 'Frontend Developer',
      location: 'Remote',
      bio: 'Frontend developer specializing in React and Vue.js',
      skills: ['React', 'Vue.js', 'CSS', 'HTML', 'JavaScript'],
      interests: ['UI/UX Design', 'Frontend Development'],
      targetRole: 'Frontend Engineer',
      level: 'Beginner',
    },
  },
];

async function createTestUsers() {
  console.log('🚀 Starting test user creation...\n');

  try {
    for (const userData of TEST_USERS) {
      const { email, password, name, role } = userData;

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        console.log(`⚠️  User ${email} already exists, skipping...`);
        continue;
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      console.log(`📝 Creating ${role} user: ${email}`);

      // Create user
      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          role,
        },
      });

      console.log(`✅ User created: ${user.id}`);

      // Create profile based on role
      if (role === 'recruiter') {
        // Create or find company
        let company;
        if (userData.company) {
          // Try to find existing company by name
          company = await prisma.company.findFirst({
            where: { name: userData.company.name },
          });
          
          // If not found, create it
          if (!company) {
            company = await prisma.company.create({
              data: userData.company,
            });
            console.log(`✅ Company created: ${company.name}`);
          } else {
            console.log(`✅ Company found: ${company.name}`);
          }
        }

        // Create recruiter profile
        await prisma.recruiterProfile.create({
          data: {
            userId: user.id,
            companyId: company?.id,
            ...userData.recruiterProfile,
          },
        });
        console.log(`✅ Recruiter profile created`);
      } else if (role === 'candidate') {
        // Create candidate profile
        await prisma.candidateProfile.create({
          data: {
            userId: user.id,
            ...userData.candidateProfile,
            skills: userData.candidateProfile?.skills as any,
            interests: userData.candidateProfile?.interests as any,
          },
        });
        console.log(`✅ Candidate profile created`);
      }

      console.log(`✅ ${role} user ${email} created successfully!\n`);
    }

    console.log('✅ All test users created successfully!');
    console.log('\n📋 Test Users Summary:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    for (const userData of TEST_USERS) {
      console.log(`\n${userData.role.toUpperCase()}:`);
      console.log(`  Email: ${userData.email}`);
      console.log(`  Password: ${userData.password}`);
      console.log(`  Name: ${userData.name}`);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n💡 You can now login with any of these accounts!');
    
  } catch (error: any) {
    console.error('❌ Error creating test users:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
createTestUsers()
  .then(() => {
    console.log('\n✅ Script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });

