/**
 * Email Service
 * Handles sending emails to candidates
 * Uses Nodemailer for email delivery
 * Supports SMTP, SendGrid, and other email services
 */

import nodemailer from 'nodemailer';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// Create reusable transporter
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) {
    return transporter;
  }

  // Check if email is enabled
  const emailEnabled = process.env.EMAIL_ENABLED === 'true';
  if (!emailEnabled) {
    console.log('📧 Email service is disabled (EMAIL_ENABLED=false). Set EMAIL_ENABLED=true and configure email settings to enable.');
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
    console.log('✅ Using Supabase SMTP for email delivery');
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
    console.log('✅ Using SMTP for email delivery');
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
    console.log('✅ Using SendGrid for email delivery');
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
  console.warn('⚠️ No email service configured. Set up SENDGRID_API_KEY, SMTP settings, or Gmail OAuth2 to enable email sending.');
  return null;
}

export async function sendEmail(options: EmailOptions): Promise<{ success: boolean; error?: string }> {
  try {
    const emailTransporter = getTransporter();
    
    if (!emailTransporter) {
      // Email service not configured - log for development
      console.log('📧 Email would be sent (email service not configured):', {
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
    
    console.log('✅ Email sent successfully:', {
      to: options.to,
      messageId: info.messageId,
      response: info.response
    });

    return { success: true };
  } catch (error: any) {
    console.error('❌ Email sending error:', error);
    return { success: false, error: error.message };
  }
}

export function generateAssessmentEmail(
  candidateName: string,
  candidateEmail: string,
  companyName: string,
  recruiterName: string,
  sessionCode: string,
  assessmentUrl: string,
  jobTitle?: string,
  timeLimitMinutes?: number
): EmailOptions {
  // Format time limit
  const formatTimeLimit = (minutes?: number): string => {
    if (!minutes) return '60 minutes (1 hour)';
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    return `${hours} hour${hours > 1 ? 's' : ''} ${mins} minute${mins > 1 ? 's' : ''}`;
  };

  const timeLimit = formatTimeLimit(timeLimitMinutes);
  const subject = `${companyName} - Assessment Invitation${jobTitle ? ` - ${jobTitle}` : ''}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Assessment Invitation</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Assessment Invitation</h1>
        </div>
        
        <div style="background: #ffffff; padding: 40px 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <p style="font-size: 16px; margin: 0 0 20px 0;">Dear ${candidateName || 'Candidate'},</p>
          
          <p style="font-size: 16px; margin: 0 0 20px 0;">On behalf of <strong style="color: #667eea;">${companyName}</strong>, we are pleased to invite you to take an assessment${jobTitle ? ` for the position of <strong>${jobTitle}</strong>` : ''}.</p>
          
          <div style="background: #f8f9fa; border-left: 4px solid #667eea; padding: 20px; margin: 25px 0; border-radius: 4px;">
            <h2 style="color: #667eea; margin: 0 0 15px 0; font-size: 18px;">📋 Assessment Details</h2>
            <table style="width: 100%; border-collapse: collapse;">
              ${jobTitle ? `
              <tr style="margin-bottom: 10px;">
                <td style="padding: 8px 0; font-weight: 600; color: #555; width: 140px;">Job Role:</td>
                <td style="padding: 8px 0; color: #333;">${jobTitle}</td>
              </tr>
              ` : ''}
              <tr>
                <td style="padding: 8px 0; font-weight: 600; color: #555; width: 140px;">Time Limit:</td>
                <td style="padding: 8px 0; color: #333;">${timeLimit}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: 600; color: #555; width: 140px;">Session Code:</td>
                <td style="padding: 8px 0; color: #667eea; font-size: 20px; font-weight: bold; font-family: monospace;">${sessionCode}</td>
              </tr>
            </table>
          </div>
          
          <div style="background: #e8f4f8; border: 1px solid #b3d9e6; padding: 20px; margin: 25px 0; border-radius: 6px;">
            <h2 style="color: #2c5f7d; margin: 0 0 15px 0; font-size: 18px;">🎯 What to Expect</h2>
            <ul style="margin: 0; padding-left: 20px; color: #2c5f7d;">
              <li style="margin-bottom: 10px;">You will have <strong>${timeLimit}</strong> to complete the assessment</li>
              <li style="margin-bottom: 10px;">The assessment may include coding challenges, problem-solving tasks, or technical questions</li>
              <li style="margin-bottom: 10px;">You can use the AI assistant during the assessment for guidance and help</li>
              <li style="margin-bottom: 10px;">Make sure you have a stable internet connection and a quiet environment</li>
              <li style="margin-bottom: 10px;">The timer starts when you begin the assessment</li>
            </ul>
          </div>
          
          <div style="text-align: center; margin: 35px 0;">
            <a href="${assessmentUrl}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(102, 126, 234, 0.3);">
              🚀 Start Assessment
            </a>
          </div>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 25px 0;">
            <p style="margin: 0 0 10px 0; font-size: 14px; color: #666; font-weight: 600;">Or copy and paste this URL into your browser:</p>
            <p style="background: #ffffff; padding: 12px; border-radius: 4px; word-break: break-all; font-size: 13px; color: #667eea; margin: 0; border: 1px solid #e0e0e0;">${assessmentUrl}</p>
          </div>
          
          <div style="border-top: 1px solid #e0e0e0; padding-top: 25px; margin-top: 30px;">
            <p style="margin: 0 0 5px 0; font-size: 16px;">Best regards,</p>
            <p style="margin: 0; font-size: 16px; font-weight: 600; color: #667eea;">${recruiterName}</p>
            <p style="margin: 5px 0 0 0; font-size: 14px; color: #666;">${companyName}</p>
          </div>
        </div>
        
        <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
          <p style="margin: 0;">This is an automated email. Please do not reply to this message.</p>
        </div>
      </body>
    </html>
  `;

  const text = `
Assessment Invitation

Dear ${candidateName || 'Candidate'},

On behalf of ${companyName}, we are pleased to invite you to take an assessment${jobTitle ? ` for the position of ${jobTitle}` : ''}.

ASSESSMENT DETAILS:
${jobTitle ? `Job Role: ${jobTitle}\n` : ''}Time Limit: ${timeLimit}
Session Code: ${sessionCode}

WHAT TO EXPECT:
- You will have ${timeLimit} to complete the assessment
- The assessment may include coding challenges, problem-solving tasks, or technical questions
- You can use the AI assistant during the assessment for guidance and help
- Make sure you have a stable internet connection and a quiet environment
- The timer starts when you begin the assessment

Start your assessment by clicking this link:
${assessmentUrl}

Or copy and paste the URL into your browser:
${assessmentUrl}

Best regards,
${recruiterName}
${companyName}

---
This is an automated email. Please do not reply to this message.
  `;

  return {
    to: candidateEmail,
    subject,
    html,
    text
  };
}

