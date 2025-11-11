/**
 * Script to update candidate password in the database
 * Usage: npx ts-node scripts/update-candidate-password.ts
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function updateCandidatePassword() {
  const email = 'candidate@test.com';
  const newPassword = 'Candidate_YCW26';

  try {
    // Find the user
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      console.error(`❌ User with email ${email} not found`);
      process.exit(1);
    }

    if (user.role !== 'candidate') {
      console.error(`❌ User ${email} is not a candidate (role: ${user.role})`);
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

updateCandidatePassword();

