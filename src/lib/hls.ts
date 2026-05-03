import path from 'path';
import fs from 'fs';

const HLS_OUTPUT_DIR = path.join(process.cwd(), 'uploads', 'hls');

/**
 * Get HLS playlist URL for a session.
 * Kept for backward compatibility — the video route still returns this URL in its response.
 */
export function getHLSPlaylistUrl(sessionId: string, streamType: string = 'webcam'): string {
  return `/hls/${sessionId}/${streamType}.m3u8`;
}

/**
 * Check if an HLS playlist file exists for a session (legacy).
 */
export function hasHLSPlaylist(sessionId: string): boolean {
  const playlistPath = path.join(HLS_OUTPUT_DIR, sessionId, 'playlist.m3u8');
  return fs.existsSync(playlistPath);
}

/**
 * updateHLSPlaylist — deprecated no-op.
 * Video chunks are read directly from Supabase Storage; no local HLS files are generated.
 */
export async function updateHLSPlaylist(sessionId: string): Promise<string> {
  return path.join(HLS_OUTPUT_DIR, sessionId, 'webcam.m3u8');
}
