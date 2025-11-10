/**
 * Test Email Configuration
 * Run this script to test if email service is configured correctly
 * Usage: npx ts-node test-email.ts
 */

import { sendEmail, generateAssessmentEmail } from './src/lib/email';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function testEmail() {
  console.log('🧪 Testing Email Configuration...\n');

  // Check environment variables
  console.log('📋 Environment Variables:');
  console.log(`  EMAIL_ENABLED: ${process.env.EMAIL_ENABLED}`);
  console.log(`  SUPABASE_SMTP_HOST: ${process.env.SUPABASE_SMTP_HOST || 'NOT SET'}`);
  console.log(`  SUPABASE_SMTP_PORT: ${process.env.SUPABASE_SMTP_PORT || 'NOT SET'}`);
  console.log(`  SUPABASE_SMTP_USER: ${process.env.SUPABASE_SMTP_USER || 'NOT SET'}`);
  console.log(`  SUPABASE_SMTP_PASS: ${process.env.SUPABASE_SMTP_PASS ? 'SET (hidden)' : 'NOT SET'}`);
  console.log(`  FROM_EMAIL: ${process.env.FROM_EMAIL || 'NOT SET'}`);
  console.log(`  FRONTEND_URL: ${process.env.FRONTEND_URL || 'NOT SET'}`);
  console.log('');

  // Test email generation
  console.log('📧 Generating test email...');
  const testEmail = generateAssessmentEmail(
    'Test Candidate',
    process.env.TEST_EMAIL || 'test@example.com',
    'Test Company',
    'Test Recruiter',
    'TEST1234',
    'http://localhost:3000/assessment/TEST1234',
    'Software Engineer',
    60
  );

  console.log('  ✅ Email template generated');
  console.log(`  To: ${testEmail.to}`);
  console.log(`  Subject: ${testEmail.subject}`);
  console.log('');

  // Test email sending
  console.log('📤 Attempting to send test email...');
  const testRecipient = process.env.TEST_EMAIL || process.argv[2] || 'test@example.com';
  console.log(`  Sending to: ${testRecipient}`);
  console.log('');
  
  try {
    const result = await sendEmail({
      to: testRecipient,
      subject: '🧪 Test Email from Promora Assessment System',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #667eea;">✅ Email Test Successful!</h1>
          <p>If you're reading this, your email configuration is working correctly!</p>
          <p><strong>Configuration Details:</strong></p>
          <ul>
            <li>SMTP Host: ${process.env.SUPABASE_SMTP_HOST || 'N/A'}</li>
            <li>SMTP Port: ${process.env.SUPABASE_SMTP_PORT || 'N/A'}</li>
            <li>From Email: ${process.env.FROM_EMAIL || 'N/A'}</li>
          </ul>
          <p style="margin-top: 20px; color: #666;">This is a test email from the Promora Assessment System.</p>
        </div>
      `,
      text: 'Email Test Successful! If you\'re reading this, your email configuration is working correctly!'
    });

    if (result.success) {
      console.log('  ✅ Email sent successfully!');
      console.log('  Check your inbox (and spam folder) for the test email.');
    } else {
      console.log('  ❌ Email sending failed:');
      console.log(`  Error: ${result.error}`);
    }
  } catch (error: any) {
    console.log('  ❌ Error testing email:');
    console.log(`  ${error.message}`);
  }

  console.log('\n✅ Test complete!');
}

// Run test
testEmail().catch(console.error);

