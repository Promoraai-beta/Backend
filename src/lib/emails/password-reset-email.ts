/**
 * Password Reset Email Template
 * Generates email for password reset requests with verification code
 */

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export function generatePasswordResetEmail(
  userEmail: string,
  userName: string,
  code: string,
  resetUrl: string
): EmailOptions {
  const subject = 'Password Reset Request - Verification Code';
  const fromName = process.env.FROM_NAME || 'Promora';
  
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Reset</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
        <div style="background: #ffffff; padding: 40px 35px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
          
          <p style="font-size: 16px; margin: 0 0 8px 0; color: #666;">Hi ${userName || 'there'},</p>
          
          <p style="font-size: 16px; margin: 0 0 24px 0; line-height: 1.7;">We received a request to reset your password. Use the verification code below to proceed:</p>
          
          <div style="background: #f8f9fa; padding: 24px; border-radius: 6px; margin: 0 0 28px 0; border-left: 3px solid #667eea; text-align: center;">
            <p style="margin: 0 0 8px 0; font-size: 14px; color: #555; text-transform: uppercase; letter-spacing: 1px;">Verification Code</p>
            <p style="margin: 0; font-size: 32px; font-weight: 700; color: #667eea; letter-spacing: 8px; font-family: 'Courier New', monospace;">${code}</p>
            <p style="margin: 12px 0 0 0; font-size: 13px; color: #999;">This code expires in 15 minutes</p>
          </div>
          
          <p style="font-size: 15px; margin: 0 0 24px 0; line-height: 1.7; color: #555;">Enter this code on the password reset page to verify your identity and set a new password.</p>
          
          <div style="text-align: center; margin: 32px 0;">
            <a href="${resetUrl}" style="background: #667eea; color: white; padding: 15px 48px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; font-size: 16px; letter-spacing: 0.3px;">
              RESET PASSWORD
            </a>
          </div>
          
          <div style="background: #fff8e6; border: 1px solid #ffe7a3; padding: 16px; border-radius: 6px; margin: 24px 0 0 0;">
            <p style="margin: 0; font-size: 14px; color: #856404;">
              <strong>Security Notice:</strong> If you didn't request this password reset, please ignore this email. Your password will remain unchanged.
            </p>
          </div>
          
          <div style="margin-top: 36px; padding-top: 24px; border-top: 1px solid #e8e8e8;">
            <p style="margin: 0; font-size: 13px; color: #999;">This is an automated email from ${fromName}. Please do not reply to this message.</p>
          </div>
          
        </div>
      </body>
    </html>
  `;

  const text = `
Hi ${userName || 'there'},

We received a request to reset your password. Use the verification code below to proceed:

Verification Code: ${code}
(This code expires in 15 minutes)

Enter this code on the password reset page to verify your identity and set a new password.

Reset Password: ${resetUrl}

Security Notice: If you didn't request this password reset, please ignore this email. Your password will remain unchanged.

---
This is an automated email from ${fromName}. Please do not reply to this message.
  `;

  return {
    to: userEmail,
    subject,
    html,
    text
  };
}

