import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { prisma } from '../lib/prisma';
import { buildVideoChunkPath } from '../lib/storage-utils';
import { logger } from '../lib/logger';

interface VideoChunkMessage {
  type: 'video-chunk';
  sessionId: string;
  chunkIndex: number;
  streamType: 'webcam' | 'screenshare';
  data: string; // Base64 encoded video data
}

interface ClientInfo {
  sessionId: string;
  clientType: 'candidate' | 'recruiter';
  ws: WebSocket;
}

// Initialize Supabase client for storage
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

class VideoStreamServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, Set<ClientInfo>> = new Map(); // sessionId -> Set of clients
  private sessions: Map<string, ClientInfo[]> = new Map(); // sessionId -> [candidate, ...recruiters]

  initialize(server: any) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws/video'
    });

    this.wss.on('connection', (ws: WebSocket, req: any) => {
      logger.log('New WebSocket connection');

      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'register') {
            await this.handleRegister(ws, message.sessionId, message.clientType);
          } else if (message.type === 'video-chunk') {
            await this.handleVideoChunk(message);
          }
        } catch (error: any) {
          logger.error('WebSocket message error:', error.message);
          ws.send(JSON.stringify({
            type: 'error',
            message: error.message
          }));
        }
      });

      ws.on('close', () => {
        logger.log('WebSocket disconnected');
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });

    logger.log('Video streaming WebSocket server initialized');
  }

  private async handleRegister(ws: WebSocket, sessionId: string, clientType: 'candidate' | 'recruiter') {
    logger.log(`Client registered: ${clientType} for session ${sessionId}`);

    const clientInfo: ClientInfo = {
      sessionId,
      clientType,
      ws
    };

    // Add to session clients
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    this.sessions.get(sessionId)!.push(clientInfo);

    // Add to tracking map
    if (!this.clients.has(sessionId)) {
      this.clients.set(sessionId, new Set());
    }
    this.clients.get(sessionId)!.add(clientInfo);

    ws.send(JSON.stringify({
      type: 'registered',
      sessionId,
      clientType
    }));
  }

  private async handleVideoChunk(message: VideoChunkMessage) {
    const sessionClients = this.clients.get(message.sessionId);
    if (!sessionClients) {
      logger.log(`No clients for session ${message.sessionId}`);
    }

    // 1. Store chunk to Supabase (async, don't block forwarding)
    this.storeChunkToSupabase(message).catch(error => {
      logger.error(`Failed to store chunk ${message.chunkIndex} to Supabase:`, error);
    });

    // 2. Forward chunk to all recruiters watching this session
    const recruiters = sessionClients
      ? Array.from(sessionClients).filter(c => c.clientType === 'recruiter')
      : [];

    for (const recruiter of recruiters) {
      if (recruiter.ws.readyState === WebSocket.OPEN) {
        recruiter.ws.send(JSON.stringify({
          type: 'video-chunk',
          chunkIndex: message.chunkIndex,
          streamType: message.streamType,
          data: message.data
        }));
      }
    }

    logger.log(`Broadcasted ${message.streamType} chunk ${message.chunkIndex} to ${recruiters.length} recruiters`);
  }

  /**
   * Store video chunk to Supabase storage.
   * Fallback path for chunks arriving via WebSocket rather than HTTP upload.
   * No DB record — the video GET endpoint reads directly from Supabase Storage.
   */
  private async storeChunkToSupabase(message: VideoChunkMessage) {
    if (!supabase) {
      logger.warn('Supabase not configured, skipping chunk storage');
      return;
    }

    try {
      // Fetch session details to build the Supabase storage path
      const session = await prisma.session.findUnique({
        where: { id: message.sessionId },
        include: {
          assessment: {
            include: { company: true }
          }
        }
      });

      if (!session) {
        logger.warn(`Session ${message.sessionId} not found, skipping chunk storage`);
        return;
      }

      // Only store chunks for recruiter assessments
      if (session.assessment?.assessmentType === 'candidate') {
        return;
      }

      const companyName = session.assessment?.company?.name || 'UnknownCompany';
      const jobName = (session.assessment as any)?.jobTitle || (session.assessment as any)?.role || 'UnknownJob';
      const candidateName = session.candidateName || session.sessionCode || 'UnknownCandidate';

      const timestamp = Date.now();
      const filePath = buildVideoChunkPath(
        companyName,
        jobName,
        candidateName,
        message.streamType,
        message.chunkIndex,
        timestamp
      );

      const buffer = Buffer.from(message.data, 'base64');

      if (buffer.length === 0) {
        logger.warn(`Skipping empty chunk ${message.chunkIndex} for ${message.streamType}`);
        return;
      }

      const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';

      logger.log(`📦 Storing ${message.streamType} chunk ${message.chunkIndex} via WebSocket: ${filePath} (${buffer.length} bytes)`);

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, buffer, {
          contentType: 'video/webm',
          upsert: false // HTTP upload takes precedence if already present
        });

      if (uploadError) {
        if (uploadError.message?.includes('already exists') || uploadError.message?.includes('duplicate')) {
          logger.log(`Chunk ${message.chunkIndex} already in Supabase (HTTP upload beat us) — skipping`);
        } else {
          throw uploadError;
        }
      } else {
        logger.log(`✅ Stored ${message.streamType} chunk ${message.chunkIndex} to Supabase via WebSocket`);
      }

    } catch (error: any) {
      logger.error(`Error storing chunk ${message.chunkIndex} to Supabase:`, error);
    }
  }

  private handleDisconnect(ws: WebSocket) {
    for (const [sessionId, clients] of this.clients.entries()) {
      for (const client of clients) {
        if (client.ws === ws) {
          clients.delete(client);
          logger.log(`Removed ${client.clientType} from session ${sessionId}`);

          if (clients.size === 0) {
            this.clients.delete(sessionId);
          }

          const sessionArray = this.sessions.get(sessionId);
          if (sessionArray) {
            const index = sessionArray.indexOf(client);
            if (index > -1) {
              sessionArray.splice(index, 1);
            }
            if (sessionArray.length === 0) {
              this.sessions.delete(sessionId);
            }
          }
        }
      }
    }
  }

  getConnectedRecruiters(sessionId: string): number {
    const clients = this.clients.get(sessionId);
    if (!clients) return 0;
    return Array.from(clients).filter(c => c.clientType === 'recruiter').length;
  }
}

export const videoStreamServer = new VideoStreamServer();
