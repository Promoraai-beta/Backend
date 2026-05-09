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
import { Resend } from 'resend';
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

// ── Resend HTTP API (preferred) ───────────────────────────────────────────────
// Uses the Resend SDK directly — this is the ONLY way onboarding@resend.dev works.
// Resend SMTP requires a verified custom domain; the HTTP API does not.

let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  if (resendClient) return resendClient;
  const key = process.env.SUPABASE_SMTP_PASS; // re_*** API key stored here
  if (process.env.EMAIL_ENABLED !== 'true') return null;
  if (!key || !key.startsWith('re_')) return null;
  resendClient = new Resend(key);
  logger.log('✅ Using Resend HTTP API for email delivery');
  return resendClient;
}

// ── SMTP fallback (for custom domains / other providers) ──────────────────────
let smtpTransporter: nodemailer.Transporter | null = null;

function getSmtpTransporter(): nodemailer.Transporter | null {
  if (smtpTransporter) return smtpTransporter;
  if (process.env.EMAIL_ENABLED !== 'true') return null;

  if (process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS) {
    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    logger.log('✅ Using SMTP for email delivery');
    return smtpTransporter;
  }

  if (process.env.SENDGRID_API_KEY) {
    smtpTransporter = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY },
    });
    logger.log('✅ Using SendGrid for email delivery');
    return smtpTransporter;
  }

  return null;
}

export async function sendEmail(
  options: EmailOptions
): Promise<{ success: boolean; delivered: boolean; error?: string }> {
  const emailEnabled = process.env.EMAIL_ENABLED === 'true';
  if (!emailEnabled) {
    logger.log('📧 Email skipped (EMAIL_ENABLED=false):', options.to);
    return { success: true, delivered: false };
  }

  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  const fromName  = process.env.FROM_NAME  || 'Promora Assessment';
  const from      = `${fromName} <${fromEmail}>`;

  // ── 1. Try Resend HTTP API first ───────────────────────────────────────────
  const resend = getResendClient();
  if (resend) {
    try {
      const { data, error } = await resend.emails.send({
        from,
        to:      options.to,
        subject: options.subject,
        html:    options.html,
        text:    options.text || options.html.replace(/<[^>]*>/g, ''),
      });

      if (error) {
        logger.error('❌ Resend API error:', error);
        return { success: false, delivered: false, error: JSON.stringify(error) };
      }

      logger.log('✅ Email sent via Resend:', { to: options.to, id: data?.id });
      return { success: true, delivered: true };
    } catch (err: any) {
      logger.error('❌ Resend exception:', err?.message || err);
      return { success: false, delivered: false, error: err?.message };
    }
  }

  // ── 2. Fall back to SMTP ───────────────────────────────────────────────────
  const smtp = getSmtpTransporter();
  if (smtp) {
    try {
      const info = await smtp.sendMail({ from, to: options.to, subject: options.subject, html: options.html, text: options.text });
      logger.log('✅ Email sent via SMTP:', { to: options.to, messageId: info.messageId });
      return { success: true, delivered: true };
    } catch (err: any) {
      logger.error('❌ SMTP error:', err?.message || err);
      return { success: false, delivered: false, error: err?.message };
    }
  }

  logger.warn('⚠️ No email provider configured. Check EMAIL_ENABLED and SUPABASE_SMTP_PASS (Resend API key).');
  return { success: true, delivered: false };
}

