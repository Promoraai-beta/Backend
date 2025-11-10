/**
 * Email Service
 * Handles sending emails using Nodemailer
 * Supports SMTP, SendGrid, Supabase/Resend, and other email services
 * 
 * Email templates are organized in separate files:
 * - emails/assessment-email.ts - Assessment invitation emails
 * - emails/password-reset-email.ts - Password reset emails
 * - emails/recruiter-invitation-email.ts - Recruiter invitation emails
 */

import nodemailer from 'nodemailer';
import { logger } from './logger';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// Re-export email template functions for convenience
export { generateAssessmentEmail } from './emails/assessment-email';
export { generatePasswordResetEmail } from './emails/password-reset-email';
export { generateRecruiterInvitationEmail } from './emails/recruiter-invitation-email';

// Create reusable transporter
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) {
    return transporter;
  }

  // Check if email is enabled
  const emailEnabled = process.env.EMAIL_ENABLED === 'true';
  if (!emailEnabled) {
    logger.log('📧 Email service is disabled (EMAIL_ENABLED=false). Set EMAIL_ENABLED=true and configure email settings to enable.');
    return null;
  }

  // Try Supabase SMTP first (if configured)
  // Supabase uses Resend SMTP service
  if (process.env.SUPABASE_SMTP_HOST && process.env.SUPABASE_SMTP_USER && process.env.SUPABASE_SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SUPABASE_SMTP_HOST,
      port: parseInt(process.env.SUPABASE_SMTP_PORT || '587'),
      secure: process.env.SUPABASE_SMTP_SECURE === 'true', // true for 465, false for 587
      auth: {
        user: process.env.SUPABASE_SMTP_USER,
        pass: process.env.SUPABASE_SMTP_PASS
      }
    });
    logger.log('✅ Using Supabase SMTP for email delivery');
    return transporter;
  }

  // Try generic SMTP configuration (for other SMTP services)
  if (process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    logger.log('✅ Using SMTP for email delivery');
    return transporter;
  }

  // Try SendGrid (if configured)
  // SendGrid uses SMTP with specific settings
  if (process.env.SENDGRID_API_KEY) {
    transporter = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY
      }
    });
    logger.log('✅ Using SendGrid for email delivery');
    return transporter;
  }

  // Fallback: Gmail OAuth2 (if configured)
  if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: process.env.GMAIL_USER,
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        refreshToken: process.env.GMAIL_REFRESH_TOKEN
      }
    });
    return transporter;
  }

  // No email configuration found
  logger.warn('⚠️ No email service configured. Set up SENDGRID_API_KEY, SMTP settings, or Gmail OAuth2 to enable email sending.');
  return null;
}

export async function sendEmail(options: EmailOptions): Promise<{ success: boolean; error?: string }> {
  try {
    const emailTransporter = getTransporter();
    
    if (!emailTransporter) {
      // Email service not configured - log for development
      logger.log('📧 Email would be sent (email service not configured):', {
        to: options.to,
        subject: options.subject,
        html: options.html.substring(0, 100) + '...'
      });
      return { success: true }; // Return success in development mode
    }

    const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@promora.ai';
    const fromName = process.env.FROM_NAME || 'Promora Assessment';

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || options.html.replace(/<[^>]*>/g, '') // Strip HTML for text version
    };

    const info = await emailTransporter.sendMail(mailOptions);
    
    logger.log('✅ Email sent successfully:', {
      to: options.to,
      messageId: info.messageId,
      response: info.response
    });

    return { success: true };
  } catch (error: any) {
    logger.error('❌ Email sending error:', error);
    return { success: false, error: error.message };
  }
}

