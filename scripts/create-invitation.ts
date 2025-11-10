/**
 * Script to create recruiter invitations manually
 * Usage: npx ts-node scripts/create-invitation.ts [email] [companyName] [expiresInDays]
 * 
 * Example:
 *   npx ts-node scripts/create-invitation.ts recruiter@company.com "Acme Inc" 30
 *   npx ts-node scripts/create-invitation.ts "" "Tech Corp" 30  (open invitation)
 */

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function createInvitation(email?: string, companyName?: string, expiresInDays: number = 30) {
  try {
    // Generate unique token
    const token = crypto.randomBytes(32).toString('hex');

    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    // Check if company exists
    let companyId = null;
    if (companyName) {
      const existingCompany = await prisma.company.findFirst({
        where: { name: companyName }
      });

      if (existingCompany) {
        companyId = existingCompany.id;
      }
    }

    // Create invitation
    const invitation = await prisma.invitation.create({
      data: {
        token,
        email: email || null,
        companyId: companyId || null,
        companyName: companyName || null,
        role: 'recruiter',
        expiresAt,
        createdBy: null // System-generated
      },
      include: {
        company: true
      }
    });

    // Generate invitation URL
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const invitationUrl = `${frontendUrl}/invite/${token}`;

    console.log('\n✅ Invitation created successfully!\n');
    console.log('Invitation Details:');
    console.log(`  Token: ${token}`);
    console.log(`  Email: ${email || '(open invitation)'}`);
    console.log(`  Company: ${companyName || invitation.company?.name || 'Not specified'}`);
    console.log(`  Expires: ${expiresAt.toISOString()}`);
    console.log(`  Invitation URL: ${invitationUrl}\n`);

    return invitation;
  } catch (error: any) {
    console.error('Error creating invitation:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Get command line arguments
const args = process.argv.slice(2);
const email = args[0] || undefined;
const companyName = args[1] || undefined;
const expiresInDays = parseInt(args[2]) || 30;

if (!email && !companyName) {
  console.log('Usage: npx ts-node scripts/create-invitation.ts [email] [companyName] [expiresInDays]');
  console.log('\nExamples:');
  console.log('  npx ts-node scripts/create-invitation.ts recruiter@company.com "Acme Inc" 30');
  console.log('  npx ts-node scripts/create-invitation.ts "" "Tech Corp" 30  (open invitation)');
  process.exit(1);
}

createInvitation(email, companyName, expiresInDays)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

