import path from 'path';
import fs from 'fs';
import { prisma } from '../lib/prisma';

const HLS_OUTPUT_DIR = path.join(process.cwd(), 'uploads', 'hls');
const SEGMENT_DURATION = 5; // 5 seconds per segment
const PLAYLIST_SIZE = 20; // Keep last 20 segments in playlist

/**
 * Generate or update HLS playlists for a session
 * Creates separate playlists for webcam and screenshare
 */
export async function updateHLSPlaylist(sessionId: string): Promise<string> {
  const sessionHlsDir = path.join(HLS_OUTPUT_DIR, sessionId);
  
  if (!fs.existsSync(sessionHlsDir)) {
    fs.mkdirSync(sessionHlsDir, { recursive: true });
  }

  // Get video chunks grouped by stream type
  const allChunks = await prisma.videoChunk.findMany({
    where: { sessionId },
    orderBy: { chunkIndex: 'asc' }
  });

  // Group by stream type from URL path
  const webcamChunks = allChunks.filter(chunk => chunk.url.includes('/webcam/'));
  const screenshareChunks = allChunks.filter(chunk => chunk.url.includes('/screenshare/'));

  // Generate playlists for each stream type
  generatePlaylistForStream(sessionHlsDir, webcamChunks, 'webcam');
  generatePlaylistForStream(sessionHlsDir, screenshareChunks, 'screenshare');

  // Return default webcam playlist path for backward compatibility
  return path.join(sessionHlsDir, 'webcam.m3u8');
}

function generatePlaylistForStream(sessionHlsDir: string, chunks: any[], streamType: string) {
  const playlistPath = path.join(sessionHlsDir, `${streamType}.m3u8`);

  if (chunks.length === 0) {
    const emptyPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${SEGMENT_DURATION}
#EXT-X-MEDIA-SEQUENCE:0
`;
    fs.writeFileSync(playlistPath, emptyPlaylist);
    return;
  }

  // Get recent chunks only
  const recentChunks = chunks.slice(-PLAYLIST_SIZE);
  const mediaSequence = recentChunks[0]?.chunkIndex || 0;

  let playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${SEGMENT_DURATION}
#EXT-X-MEDIA-SEQUENCE:${mediaSequence}
#EXT-X-PLAYLIST-TYPE:EVENT
`;

  recentChunks.forEach(chunk => {
    let url = chunk.url;
    if (url.startsWith('/uploads/videos/')) {
      url = chunk.url;
    } else if (url.startsWith('http')) {
      url = chunk.url;
    }

    playlist += `#EXTINF:${SEGMENT_DURATION}.0,
${url}
`;
  });

  fs.writeFileSync(playlistPath, playlist);
}

/**
 * Get HLS playlist URL for a session
 */
export function getHLSPlaylistUrl(sessionId: string, streamType: string = 'webcam'): string {
  return `/hls/${sessionId}/${streamType}.m3u8`;
}

/**
 * Check if HLS playlist exists for a session
 */
export function hasHLSPlaylist(sessionId: string): boolean {
  const playlistPath = path.join(HLS_OUTPUT_DIR, sessionId, 'playlist.m3u8');
  return fs.existsSync(playlistPath);
}

