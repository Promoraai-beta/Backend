/**
 * Recruiter Invitation Email Template
 * Generates email for recruiter invitation links
 */

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export function generateRecruiterInvitationEmail(
  recruiterEmail: string,
  recruiterName: string | null,
  companyName: string,
  invitationUrl: string,
  expiresAt?: Date | string
): EmailOptions {
  const subject = `Join ${companyName} on Promora`;
  const fromName = process.env.FROM_NAME || 'Promora';
  
  // Format expiration date
  const formatExpiration = (date?: Date | string): string => {
    if (!date) return '';
    const expiration = typeof date === 'string' ? new Date(date) : date;
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const month = months[expiration.getMonth()];
    const day = expiration.getDate();
    const year = expiration.getFullYear();
    return `${month} ${day}, ${year}`;
  };

  const expirationDate = formatExpiration(expiresAt);
  const displayName = recruiterName || recruiterEmail.split('@')[0];
  
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Recruiter Invitation</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
        <div style="background: #ffffff; padding: 40px 35px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
          
          <p style="font-size: 16px; margin: 0 0 8px 0; color: #666;">Hi ${displayName},</p>
          
          <p style="font-size: 16px; margin: 0 0 24px 0; line-height: 1.7;">You've been invited to join <strong>${companyName}</strong> as a recruiter on Promora.</p>
          
          ${expirationDate ? `
          <div style="background: #f8f9fa; padding: 16px; border-radius: 6px; margin: 0 0 24px 0; border-left: 3px solid #667eea;">
            <p style="margin: 0; font-size: 14px; color: #555;">
              <strong>Invitation expires:</strong> ${expirationDate}
            </p>
          </div>
          ` : ''}
          
          <p style="font-size: 15px; margin: 0 0 24px 0; line-height: 1.7; color: #555;">Click the button below to accept the invitation and create your recruiter account:</p>
          
          <div style="text-align: center; margin: 32px 0;">
            <a href="${invitationUrl}" style="background: #667eea; color: white; padding: 15px 48px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; font-size: 16px; letter-spacing: 0.3px;">
              ACCEPT INVITATION
            </a>
          </div>
          
          <div style="border-top: 1px solid #e8e8e8; padding-top: 28px; margin-top: 32px;">
            <h3 style="font-size: 17px; margin: 0 0 16px 0; color: #333; font-weight: 600;">What you can do as a recruiter:</h3>
            
            <ul style="margin: 0 0 20px 0; padding-left: 20px; color: #555; font-size: 15px;">
              <li style="margin-bottom: 10px; line-height: 1.6;">Create and manage coding assessments</li>
              <li style="margin-bottom: 10px; line-height: 1.6;">Invite candidates to take assessments</li>
              <li style="margin-bottom: 10px; line-height: 1.6;">Review candidate submissions and results</li>
              <li style="margin-bottom: 10px; line-height: 1.6;">Track assessment performance and analytics</li>
            </ul>
          </div>
          
          <div style="margin-top: 36px; padding-top: 24px; border-top: 1px solid #e8e8e8;">
            <p style="margin: 0; font-size: 13px; color: #999;">This is an automated email from ${fromName}. Please do not reply to this message.</p>
          </div>
          
        </div>
      </body>
    </html>
  `;

  const text = `
Hi ${displayName},

You've been invited to join ${companyName} as a recruiter on Promora.

${expirationDate ? `Invitation expires: ${expirationDate}\n` : ''}
Accept invitation: ${invitationUrl}

What you can do as a recruiter:
- Create and manage coding assessments
- Invite candidates to take assessments
- Review candidate submissions and results
- Track assessment performance and analytics

---
This is an automated email from ${fromName}. Please do not reply to this message.
  `;

  return {
    to: recruiterEmail,
    subject,
    html,
    text
  };
}

