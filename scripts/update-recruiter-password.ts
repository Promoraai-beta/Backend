/**
 * Script to update recruiter password in the database
 * Usage: npx ts-node scripts/update-recruiter-password.ts
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function updateRecruiterPassword() {
  const email = 'recruiter@test.com';
  const newPassword = 'Recruiter_YCW26';

  try {
    // Find the user
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      console.error(`❌ User with email ${email} not found`);
      process.exit(1);
    }

    if (user.role !== 'recruiter') {
      console.error(`❌ User ${email} is not a recruiter (role: ${user.role})`);
      process.exit(1);
    }

    console.log(`✅ Found user: ${user.email} (${user.name}, role: ${user.role})`);

    // Hash the new password
    console.log('🔐 Hashing new password...');
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update the password
    console.log('📝 Updating password in database...');
    await prisma.user.update({
      where: { email },
      data: {
        password: hashedPassword,
      },
    });

    console.log(`✅ Password updated successfully for ${email}`);
    console.log(`   New password: ${newPassword}`);
    console.log(`   Hashed password: ${hashedPassword.substring(0, 20)}...`);

  } catch (error: any) {
    console.error('❌ Error updating password:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

updateRecruiterPassword();

