import { createHmac } from 'crypto';

/**
 * Shared secret for signing file-server tokens.
 * Set FILE_SERVER_SECRET in production. Falls back to JWT_SECRET, then a dev default.
 */
const SECRET =
  process.env.FILE_SERVER_SECRET ||
  process.env.JWT_SECRET ||
  'promora-dev-file-server-secret-change-in-prod';

/**
 * Returns a deterministic HMAC-SHA256 token for the given session ID.
 * Passed to the container as FILE_SERVER_TOKEN so file-server.py can
 * authenticate backend requests.
 */
export function fileServerToken(sessionId: string): string {
  return createHmac('sha256', SECRET).update(sessionId).digest('hex');
}
