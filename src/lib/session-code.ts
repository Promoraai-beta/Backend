import * as crypto from 'crypto';

/**
 * Generate a secure session code
 * Uses cryptographically secure random bytes for better security
 * Format: 8 uppercase alphanumeric characters
 */
export function generateSecureSessionCode(): string {
  // Generate 4 random bytes (8 hex characters = 32 bits of entropy)
  // Convert to uppercase alphanumeric
  const bytes = crypto.randomBytes(4);
  const hex = bytes.toString('hex').toUpperCase();
  
  // Take first 8 characters and ensure it's alphanumeric
  let code = hex.substring(0, 8);
  
  // Replace any non-alphanumeric with random alphanumeric
  code = code.replace(/[^A-Z0-9]/g, () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return chars[Math.floor(Math.random() * chars.length)];
  });
  
  // Ensure we have exactly 8 characters
  while (code.length < 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  
  return code.substring(0, 8);
}

/**
 * Validate session code format
 */
export function validateSessionCodeFormat(code: string): boolean {
  return /^[A-Z0-9]{8,}$/.test(code.toUpperCase());
}

