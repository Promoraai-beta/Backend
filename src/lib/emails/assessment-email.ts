/**
 * Assessment Invitation Email Template
 * Generates email for assessment invitations sent to candidates
 */

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export function generateAssessmentEmail(
  candidateName: string,
  candidateEmail: string,
  companyName: string,
  recruiterName: string,
  sessionCode: string,
  assessmentUrl: string,
  jobTitle?: string,
  timeLimitMinutes?: number,
  expiresAt?: Date | string
): EmailOptions {
  // Format deadline date
  const formatDeadline = (date?: Date | string): string => {
    if (!date) return '';
    const deadline = typeof date === 'string' ? new Date(date) : date;
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const month = months[deadline.getMonth()];
    const day = deadline.getDate();
    const year = deadline.getFullYear();
    const hours = deadline.getHours();
    const minutes = deadline.getMinutes();
    const ampm = hours >= 12 ? 'pm' : 'am';
    const displayHours = hours % 12 || 12;
    const displayMinutes = minutes < 10 ? `0${minutes}` : minutes;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `${month} ${day}${day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th'}, ${displayHours}:${displayMinutes} ${ampm} ${timezone}`;
  };

  const deadline = formatDeadline(expiresAt);
  const timeLimitText = timeLimitMinutes ? `${timeLimitMinutes} minute${timeLimitMinutes > 1 ? 's' : ''}` : '';
  const assessmentTitle = jobTitle ? `${jobTitle} - AI Assisted Coding Assessment` : 'AI Assisted Coding Assessment';
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
        <div style="background: #ffffff; padding: 40px 35px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
          
          <p style="font-size: 16px; margin: 0 0 8px 0; color: #666;">Hi ${candidateName || 'there'},</p>
          
          <p style="font-size: 16px; margin: 0 0 24px 0; line-height: 1.7;">You've been invited by <strong>${companyName}</strong> to take the <strong>${assessmentTitle}</strong>.</p>
          
          ${(timeLimitText || deadline) ? `
          <div style="background: #f8f9fa; padding: 20px; border-radius: 6px; margin: 0 0 28px 0; border-left: 3px solid #667eea;">
            ${timeLimitText ? `
            <p style="margin: 0 0 12px 0; font-size: 15px; color: #555;">
              <strong>Time Limit:</strong> ${timeLimitText}
            </p>
            ` : ''}
            ${deadline ? `
            <p style="margin: 0; font-size: 15px; color: #555;">
              <strong>Deadline:</strong> ${deadline}
            </p>
            ` : ''}
          </div>
          ` : ''}
          
          <div style="text-align: center; margin: 32px 0;">
            <a href="${assessmentUrl}" style="background: #667eea; color: white; padding: 15px 48px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; font-size: 16px; letter-spacing: 0.3px;">
              TAKE THE ASSESSMENT
            </a>
          </div>
          
          <div style="border-top: 1px solid #e8e8e8; padding-top: 28px; margin-top: 32px;">
            <h3 style="font-size: 17px; margin: 0 0 16px 0; color: #333; font-weight: 600;">Prepare for Your Assessment</h3>
            
            <p style="font-size: 15px; margin: 0 0 16px 0; line-height: 1.7; color: #555;">Before starting, we recommend:</p>
            
            <ul style="margin: 0 0 20px 0; padding-left: 20px; color: #555; font-size: 15px;">
              <li style="margin-bottom: 10px; line-height: 1.6;">Create your account to access the practice environment</li>
              <li style="margin-bottom: 10px; line-height: 1.6;">Sample different question types you'll encounter</li>
              <li style="margin-bottom: 10px; line-height: 1.6;">Customize environment settings to your preferences</li>
              <li style="margin-bottom: 10px; line-height: 1.6;">Use the latest Chrome, Firefox, or Edge browser on a laptop or desktop</li>
            </ul>
            
            <div style="background: #fff8e6; border: 1px solid #ffe7a3; padding: 16px; border-radius: 6px; margin: 24px 0 0 0;">
              <p style="margin: 0; font-size: 14px; color: #856404;">
                <strong>Note:</strong> This assessment requires proctoring to ensure fairness and integrity.
              </p>
            </div>
          </div>
          
          <div style="margin-top: 36px; padding-top: 24px; border-top: 1px solid #e8e8e8;">
            <p style="margin: 0 0 4px 0; font-size: 15px; color: #555;">Good luck!</p>
            <p style="margin: 0; font-size: 15px; font-weight: 600; color: #333;">— ${recruiterName || companyName}</p>
          </div>
          
        </div>
        
        <div style="text-align: center; padding: 24px 0 0 0;">
          <p style="margin: 0 0 8px 0; color: #999; font-size: 13px;">Sent from ${companyName} through Promora</p>
          <p style="margin: 0; font-size: 13px;">
            <a href="#" style="color: #667eea; text-decoration: none;">Questions? Visit our Help Center</a>
          </p>
        </div>
      </body>
    </html>
  `;

  const text = `
Hi ${candidateName || 'there'},

You've been invited by ${companyName} to take the ${assessmentTitle}.

${timeLimitText ? `Time Limit: ${timeLimitText}\n` : ''}${deadline ? `Deadline: ${deadline}\n` : ''}
Take the assessment: ${assessmentUrl}

Prepare for Your Assessment

Before starting, we recommend:
- Create your account to access the practice environment
- Sample different question types you'll encounter
- Customize environment settings to your preferences
- Use the latest Chrome, Firefox, or Edge browser on a laptop or desktop

Note: This assessment requires proctoring to ensure fairness and integrity.

Good luck!

— ${recruiterName || companyName}

---
Sent from ${companyName} through Promora
This is an automated email. Please do not reply to this message.
  `;

  return {
    to: candidateEmail,
    subject,
    html,
    text
  };
}

