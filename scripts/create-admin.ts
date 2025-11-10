/**
 * Script to create an admin user manually
 * Usage: npx ts-node scripts/create-admin.ts [email] [password] [name]
 * 
 * Example:
 *   npx ts-node scripts/create-admin.ts admin@example.com Admin1234 "Admin User"
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function createAdmin(email: string, password: string, name: string) {
  try {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      console.error(`❌ User with email ${email} already exists`);
      process.exit(1);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create admin user
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: 'admin'
      }
    });

    console.log('\n✅ Admin user created successfully!\n');
    console.log('Admin Details:');
    console.log(`  ID: ${user.id}`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Name: ${user.name}`);
    console.log(`  Role: ${user.role}`);
    console.log(`  Created: ${user.createdAt.toISOString()}\n`);
    console.log('You can now login with this admin account at /login');
    console.log('Admin dashboard: /admin/dashboard\n');

    return user;
  } catch (error: any) {
    console.error('Error creating admin:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Get command line arguments
const args = process.argv.slice(2);
const email = args[0];
const password = args[1];
const name = args[2];

if (!email || !password || !name) {
  console.log('Usage: npx ts-node scripts/create-admin.ts [email] [password] [name]');
  console.log('\nExamples:');
  console.log('  npx ts-node scripts/create-admin.ts admin@example.com Admin1234 "Admin User"');
  process.exit(1);
}

createAdmin(email, password, name)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

