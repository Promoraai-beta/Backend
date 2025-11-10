# Email Configuration Guide

## Overview

The assessment system sends automated emails to candidates when assessments are created. This guide explains how to configure email delivery.

## Email Features

When an assessment is created, candidates receive an email with:
- ✅ Company name
- ✅ Job role/position
- ✅ Assessment link (direct URL)
- ✅ Session code
- ✅ Time limit (formatted as hours/minutes)
- ✅ "What to Expect" section with assessment details
- ✅ Professional, responsive email template

## Configuration Options

### Option 1: SendGrid (Recommended for Production)

SendGrid is a cloud-based email service that's reliable and easy to set up.

1. **Sign up for SendGrid**: https://sendgrid.com
2. **Create an API Key**:
   - Go to Settings > API Keys
   - Create a new API Key with "Mail Send" permissions
   - Copy the API key

3. **Add to `.env` file**:
```env
EMAIL_ENABLED=true
SENDGRID_API_KEY=your_sendgrid_api_key_here
FROM_EMAIL=noreply@yourcompany.com
FROM_NAME=Your Company Name
FRONTEND_URL=https://yourdomain.com
```

### Option 2: SMTP (Any Email Provider)

Works with any SMTP server (Gmail, Outlook, custom SMTP, etc.).

1. **Get SMTP credentials** from your email provider
2. **Add to `.env` file**:
```env
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
FROM_EMAIL=your-email@gmail.com
FROM_NAME=Your Company Name
FRONTEND_URL=https://yourdomain.com
```

**For Gmail**:
- Enable 2-factor authentication
- Create an "App Password" (not your regular password)
- Use `smtp.gmail.com` as host, port `587`

**For Outlook/Office 365**:
- Use `smtp.office365.com` as host, port `587`
- Use your full email as username
- Use your account password (or app password if 2FA is enabled)

### Option 3: Gmail OAuth2 (Advanced)

For Gmail with OAuth2 authentication:

```env
EMAIL_ENABLED=true
GMAIL_USER=your-email@gmail.com
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
FROM_EMAIL=your-email@gmail.com
FROM_NAME=Your Company Name
FRONTEND_URL=https://yourdomain.com
```

## Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `EMAIL_ENABLED` | Yes | Enable/disable email service | `true` |
| `FROM_EMAIL` | Yes | Email address to send from | `noreply@company.com` |
| `FROM_NAME` | No | Display name for sender | `Company Name` |
| `FRONTEND_URL` | Yes | Frontend URL for assessment links | `https://yourdomain.com` |
| `SENDGRID_API_KEY` | Optional | SendGrid API key | `SG.xxx...` |
| `SMTP_HOST` | Optional | SMTP server host | `smtp.gmail.com` |
| `SMTP_PORT` | Optional | SMTP server port | `587` |
| `SMTP_SECURE` | Optional | Use SSL/TLS | `false` |
| `SMTP_USER` | Optional | SMTP username | `user@example.com` |
| `SMTP_PASS` | Optional | SMTP password | `password` |

## Development Mode

If email is not configured, the system will:
- Log email details to console
- Return success (so development can continue)
- Not actually send emails

To see what emails would be sent, check the console logs:
```
📧 Email would be sent (email service not configured): { to: '...', subject: '...' }
```

## Email Template

The email template includes:

1. **Header**: Professional gradient header with "Assessment Invitation"
2. **Assessment Details Section**:
   - Job Role (if available)
   - Time Limit (formatted)
   - Session Code (prominently displayed)
3. **What to Expect Section**:
   - Time limit reminder
   - Assessment type information
   - AI assistant availability
   - Requirements (internet, environment)
   - Timer information
4. **Call-to-Action Button**: Large, prominent "Start Assessment" button
5. **URL Fallback**: Plain text URL for copying
6. **Footer**: Company name and recruiter name

## Testing

### Test Email Sending

1. **Create an assessment** through the dashboard
2. **Check console logs** for email sending status:
   - ✅ `Email sent successfully` - Email was sent
   - ❌ `Email sending error` - Check configuration
   - 📧 `Email would be sent` - Email service not configured

### Test Email Template

You can test the email template by:
1. Creating a test assessment
2. Checking the email that was sent
3. Verifying all information is correct:
   - Company name
   - Job role
   - Time limit
   - Session code
   - Assessment URL
   - "What to expect" section

## Troubleshooting

### Emails Not Sending

1. **Check EMAIL_ENABLED**: Must be set to `true`
2. **Check email service configuration**: At least one email service must be configured
3. **Check console logs**: Look for error messages
4. **Verify credentials**: Make sure API keys/passwords are correct
5. **Check firewall/network**: SMTP ports might be blocked

### Common Errors

**"No email service configured"**:
- Set up at least one email service (SendGrid, SMTP, or Gmail OAuth2)

**"Authentication failed"**:
- Check your credentials (API key, username, password)
- For Gmail, make sure you're using an App Password, not your regular password

**"Connection timeout"**:
- Check SMTP host and port
- Verify firewall allows outbound connections on port 587/465
- Check if your network blocks SMTP

**"Email sent but not received"**:
- Check spam/junk folder
- Verify "from" email address is valid
- Check email provider's sending limits
- Verify recipient email is correct

## Production Checklist

- [ ] Configure email service (SendGrid recommended)
- [ ] Set `EMAIL_ENABLED=true`
- [ ] Set `FROM_EMAIL` to a verified domain
- [ ] Set `FROM_NAME` to your company name
- [ ] Set `FRONTEND_URL` to production URL
- [ ] Test email sending
- [ ] Verify email template looks correct
- [ ] Check spam scores (use tools like Mail Tester)
- [ ] Set up email monitoring/alerts
- [ ] Configure bounce handling (if using SendGrid)

## Security Notes

- Never commit email credentials to version control
- Use environment variables for all sensitive data
- Rotate API keys regularly
- Use app-specific passwords when possible
- Monitor email sending for abuse
- Set up rate limiting on email sending

## Support

For issues with:
- **Email delivery**: Check email service provider's status page
- **Configuration**: Review this guide and environment variables
- **Template**: Check email template in `backend/src/lib/email.ts`

## Example .env File

```env
# Email Configuration
EMAIL_ENABLED=true
FROM_EMAIL=noreply@yourcompany.com
FROM_NAME=Your Company Name
FRONTEND_URL=https://yourdomain.com

# Option 1: SendGrid
SENDGRID_API_KEY=SG.your_api_key_here

# Option 2: SMTP (uncomment to use)
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=your-email@gmail.com
# SMTP_PASS=your-app-password
```

---

**Last Updated**: $(date)
**Version**: 1.0

