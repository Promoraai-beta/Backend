/**
 * Script to check if avatar URL is saved in database
 * Run with: npx ts-node scripts/check-avatar-url.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkAvatarUrls() {
  try {
    console.log('🔍 Checking avatar URLs in database...\n');

    // Get all candidate profiles
    const profiles = await prisma.candidateProfile.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    console.log(`Found ${profiles.length} candidate profile(s):\n`);

    if (profiles.length === 0) {
      console.log('❌ No candidate profiles found in database.');
      return;
    }

    profiles.forEach((profile, index) => {
      console.log(`Profile ${index + 1}:`);
      console.log(`  User ID: ${profile.userId}`);
      console.log(`  User Email: ${profile.user?.email || 'N/A'}`);
      console.log(`  User Name: ${profile.user?.name || 'N/A'}`);
      console.log(`  Avatar URL: ${profile.avatar || '❌ NULL (not set)'}`);
      console.log(`  Created: ${profile.createdAt}`);
      console.log(`  Updated: ${profile.updatedAt}`);
      console.log('');
    });

    // Count how many have avatars
    const withAvatars = profiles.filter(p => p.avatar !== null);
    const withoutAvatars = profiles.filter(p => p.avatar === null);

    console.log(`\n📊 Summary:`);
    console.log(`  Total profiles: ${profiles.length}`);
    console.log(`  With avatar URL: ${withAvatars.length}`);
    console.log(`  Without avatar URL: ${withoutAvatars.length}`);

    if (withoutAvatars.length > 0) {
      console.log(`\n⚠️  ${withoutAvatars.length} profile(s) missing avatar URL:`);
      withoutAvatars.forEach(profile => {
        console.log(`    - ${profile.user?.email || profile.userId}`);
      });
    }

  } catch (error) {
    console.error('❌ Error checking avatar URLs:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkAvatarUrls();

