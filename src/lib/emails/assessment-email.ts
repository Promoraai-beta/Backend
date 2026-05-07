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

// PromoraAI spiral mark — black version for light backgrounds
const PROMORA_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 328 366" width="24" height="27" style="display:inline-block;vertical-align:middle;">
  <g fill="#111827" fill-rule="nonzero">
    <path d="M 41.0 93.0 L 38.0 98.0 L 25.0 147.0 L 26.0 156.0 L 34.0 165.0 L 44.0 169.0 L 181.0 169.0 L 185.0 176.0 L 183.0 181.0 L 73.0 254.0 L 68.0 259.0 L 63.0 269.0 L 63.0 279.0 L 67.0 286.0 L 109.0 323.0 L 119.0 324.0 L 128.0 320.0 L 137.0 310.0 L 202.0 205.0 L 207.0 204.0 L 211.0 207.0 L 197.0 331.0 L 202.0 339.0 L 209.0 340.0 L 241.0 326.0 L 247.0 318.0 L 248.0 305.0 L 236.0 229.0 L 226.0 201.0 L 206.0 169.0 L 179.0 143.0 L 147.0 124.0 L 64.0 89.0 L 52.0 88.0 Z"/>
    <path d="M 202.0 40.0 L 200.0 46.0 L 207.0 95.0 L 217.0 126.0 L 228.0 147.0 L 242.0 166.0 L 258.0 181.0 L 274.0 190.0 L 295.0 198.0 L 300.0 198.0 L 302.0 189.0 L 299.0 167.0 L 296.0 161.0 L 292.0 159.0 L 252.0 158.0 L 250.0 154.0 L 251.0 149.0 L 283.0 125.0 L 282.0 117.0 L 268.0 94.0 L 262.0 93.0 L 238.0 128.0 L 234.0 129.0 L 231.0 126.0 L 237.0 70.0 L 236.0 61.0 L 230.0 54.0 L 210.0 41.0 Z"/>
    <path d="M 108.0 31.0 L 105.0 35.0 L 105.0 42.0 L 110.0 50.0 L 179.0 125.0 L 188.0 132.0 L 191.0 132.0 L 203.0 123.0 L 203.0 116.0 L 158.0 33.0 L 147.0 25.0 Z"/>
    <path d="M 249.0 189.0 L 240.0 200.0 L 240.0 208.0 L 277.0 276.0 L 284.0 277.0 L 288.0 271.0 L 296.0 249.0 L 296.0 239.0 L 262.0 199.0 L 252.0 189.0 Z"/>
  </g>
</svg>`;

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
  const formatDeadline = (date?: Date | string): string => {
    if (!date) return '';
    const deadline = typeof date === 'string' ? new Date(date) : date;
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const day = deadline.getDate();
    const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
    const hours = deadline.getHours();
    const minutes = deadline.getMinutes();
    const ampm = hours >= 12 ? 'pm' : 'am';
    const displayHours = hours % 12 || 12;
    const displayMinutes = minutes < 10 ? `0${minutes}` : minutes;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `${months[deadline.getMonth()]} ${day}${suffix} at ${displayHours}:${displayMinutes} ${ampm} (${timezone})`;
  };

  const deadline = formatDeadline(expiresAt);
  const timeLimitText = timeLimitMinutes ? `${timeLimitMinutes} minutes` : '60 minutes';
  const roleTitle = jobTitle || 'Software Engineer';
  const subject = `Your coding assessment from ${companyName}`;

  // Brand colours — violet-600 / violet-50 from the PromoraAI UI
  const VIOLET  = '#7c3aed';
  const VIOLET_LIGHT = '#f5f3ff';
  const VIOLET_BORDER = '#ede9fe';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Assessment Invitation</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

          <!-- Logo bar -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              ${PROMORA_MARK_SVG}
              <span style="font-size:17px;font-weight:700;color:#111827;letter-spacing:-0.3px;margin-left:7px;vertical-align:middle;">Promora<span style="color:${VIOLET};">AI</span></span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,0.06);">

              <!-- Violet header strip -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${VIOLET};padding:30px 36px;">
                    <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:rgba(255,255,255,0.6);letter-spacing:1px;text-transform:uppercase;">${companyName}</p>
                    <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">${roleTitle}</p>
                    <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.7);">AI-Assisted Coding Assessment</p>
                  </td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:32px 36px;">

                    <p style="margin:0 0 16px;font-size:16px;color:#111827;">Hi ${candidateName || 'there'},</p>

                    <p style="margin:0 0 28px;font-size:14px;color:#6b7280;line-height:1.8;">
                      <strong style="color:#111827;">${companyName}</strong> has invited you to complete a technical coding assessment for the <strong style="color:#111827;">${roleTitle}</strong> role. You'll work in a real browser-based IDE with access to an AI assistant — how you use it is part of the evaluation.
                    </p>

                    <!-- Details box -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="background:${VIOLET_LIGHT};border:1px solid ${VIOLET_BORDER};border-radius:10px;margin-bottom:28px;">
                      <tr>
                        <td style="padding:20px 24px;">
                          <table width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                              <td width="50%" style="padding-right:16px;">
                                <p style="margin:0 0 3px;font-size:10px;font-weight:600;color:#7c3aed;text-transform:uppercase;letter-spacing:0.7px;">Time limit</p>
                                <p style="margin:0;font-size:15px;font-weight:600;color:#111827;">${timeLimitText}</p>
                              </td>
                              ${deadline ? `
                              <td width="50%" style="border-left:1px solid ${VIOLET_BORDER};padding-left:20px;">
                                <p style="margin:0 0 3px;font-size:10px;font-weight:600;color:#7c3aed;text-transform:uppercase;letter-spacing:0.7px;">Complete by</p>
                                <p style="margin:0;font-size:15px;font-weight:600;color:#111827;">${deadline}</p>
                              </td>
                              ` : ''}
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- CTA button -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                      <tr>
                        <td align="center">
                          <a href="${assessmentUrl}" style="display:inline-block;background:${VIOLET};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 52px;border-radius:10px;letter-spacing:0.2px;">
                            Start Assessment →
                          </a>
                        </td>
                      </tr>
                    </table>

                    <!-- What to expect -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f3f4f6;">
                      <tr>
                        <td style="padding-top:24px;">
                          <p style="margin:0 0 14px;font-size:10px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;">What to expect</p>
                          <table width="100%" cellpadding="0" cellspacing="0">
                            <tr><td style="padding:5px 0;font-size:13px;color:#6b7280;line-height:1.6;"><span style="color:${VIOLET};font-weight:700;margin-right:10px;">·</span>Real browser-based IDE — no local setup required</td></tr>
                            <tr><td style="padding:5px 0;font-size:13px;color:#6b7280;line-height:1.6;"><span style="color:${VIOLET};font-weight:700;margin-right:10px;">·</span>AI assistant available — your usage is part of the evaluation</td></tr>
                            <tr><td style="padding:5px 0;font-size:13px;color:#6b7280;line-height:1.6;"><span style="color:${VIOLET};font-weight:700;margin-right:10px;">·</span>Session is recorded for the hiring team's review</td></tr>
                            <tr><td style="padding:5px 0;font-size:13px;color:#6b7280;line-height:1.6;"><span style="color:${VIOLET};font-weight:700;margin-right:10px;">·</span>Use Chrome, Firefox, or Edge on a laptop or desktop</td></tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>

              <!-- Card footer -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#f9fafb;border-top:1px solid #f3f4f6;padding:20px 36px;">
                    <p style="margin:0;font-size:13px;color:#6b7280;">
                      Good luck,<br>
                      <strong style="color:#374151;">${recruiterName || companyName}</strong>
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Bottom note -->
          <tr>
            <td align="center" style="padding-top:20px;">
              <p style="margin:0;font-size:11px;color:#9ca3af;">
                Sent by ${companyName} via PromoraAI &nbsp;·&nbsp; Please do not reply to this email
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>
  `;

  const text = `
Hi ${candidateName || 'there'},

${companyName} has invited you to complete a technical coding assessment for the ${roleTitle} role.

Time limit: ${timeLimitText}
${deadline ? `Complete by: ${deadline}\n` : ''}
Start your assessment:
${assessmentUrl}

What to expect:
- Real browser-based IDE — no local setup required
- AI assistant available — your usage is part of the evaluation
- Session is recorded for the hiring team's review
- Use Chrome, Firefox, or Edge on a laptop or desktop

Good luck,
${recruiterName || companyName}

---
Sent by ${companyName} via PromoraAI. Please do not reply to this email.
  `;

  return {
    to: candidateEmail,
    subject,
    html,
    text
  };
}
