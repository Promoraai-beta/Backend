import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { prisma } from '../lib/prisma';
import { buildVideoChunkPath } from '../lib/storage-utils';

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
      console.log('New WebSocket connection');

      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          
          if (message.type === 'register') {
            await this.handleRegister(ws, message.sessionId, message.clientType);
          } else if (message.type === 'video-chunk') {
            await this.handleVideoChunk(message);
          }
        } catch (error: any) {
          console.error('WebSocket message error:', error.message);
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: error.message 
          }));
        }
      });

      ws.on('close', () => {
        console.log('WebSocket disconnected');
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });

    console.log('Video streaming WebSocket server initialized');
  }

  private async handleRegister(ws: WebSocket, sessionId: string, clientType: 'candidate' | 'recruiter') {
    console.log(`Client registered: ${clientType} for session ${sessionId}`);
    
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

    // If recruiter connects, send them chunk 0 for both streams if available
    // This allows MediaSource to initialize even if live streaming hasn't started
    if (clientType === 'recruiter' && supabase) {
      this.sendInitialChunks(ws, sessionId).catch(error => {
        console.error(`Failed to send initial chunks to recruiter:`, error);
        // Don't block - recruiter can still receive live chunks
      });
    }
  }

  /**
   * Send chunk 0 for both webcam and screenshare streams to recruiter
   * This allows MediaSource to initialize before live chunks arrive
   */
  private async sendInitialChunks(ws: WebSocket, sessionId: string) {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      // Fetch chunk 0 for both streams from database
      const chunks = await prisma.videoChunk.findMany({
        where: {
          sessionId,
          chunkIndex: 0
        },
        orderBy: { chunkIndex: 'asc' }
      });

      if (chunks.length === 0) {
        console.log(`No chunk 0 found for session ${sessionId} - will wait for live stream`);
        return;
      }

      // Download and send chunk 0 for each stream type
      for (const chunk of chunks) {
        try {
          // Extract stream type from URL
          const streamType = chunk.url.includes('/webcam/') ? 'webcam' : 
                           chunk.url.includes('/screenshare/') ? 'screenshare' : null;
          
          if (!streamType) {
            continue;
          }

          // Extract file path from Supabase URL
          // URL format: https://xxx.supabase.co/storage/v1/object/public/video/companies/.../chunk_0_*.webm
          const urlObj = new URL(chunk.url);
          const pathParts = urlObj.pathname.split('/').filter(p => p);
          
          // Find index of 'video' in path
          const videoIndex = pathParts.indexOf('video');
          if (videoIndex === -1) {
            console.error(`Invalid chunk URL format: ${chunk.url}`);
            continue;
          }
          
          // Extract file path: everything after 'video'
          const filePath = pathParts.slice(videoIndex + 1).join('/');
          
          const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';
          
          console.log(`Downloading chunk 0 for ${streamType} from Supabase: ${filePath}`);
          
          const { data, error } = await supabase!.storage
            .from(bucket)
            .download(filePath);

          if (error) {
            console.error(`Failed to download chunk 0 for ${streamType} from Supabase:`, error);
            console.error(`File path: ${filePath}, URL: ${chunk.url}`);
            // Continue - chunk 0 might arrive via live stream later
            continue;
          }

          if (!data) {
            console.error(`No data returned for chunk 0 ${streamType}`);
            continue;
          }

          // Convert to base64
          const arrayBuffer = await data.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          
          if (buffer.length === 0) {
            console.error(`Chunk 0 for ${streamType} is empty`);
            continue;
          }
          
          const base64Data = buffer.toString('base64');
          console.log(`✅ Downloaded chunk 0 for ${streamType}: ${buffer.length} bytes`);

          // Send chunk 0 to recruiter
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'video-chunk',
              chunkIndex: 0,
              streamType: streamType,
              data: base64Data
            }));
            console.log(`✅ Sent chunk 0 for ${streamType} to recruiter`);
          }
        } catch (error: any) {
          console.error(`Error sending chunk 0 for stream:`, error);
          // Continue with other streams
        }
      }
    } catch (error: any) {
      console.error(`Error fetching initial chunks:`, error);
    }
  }

  private async handleVideoChunk(message: VideoChunkMessage) {
    const sessionClients = this.clients.get(message.sessionId);
    if (!sessionClients) {
      console.log(`No clients for session ${message.sessionId}`);
    }

    // 1. Store chunk to Supabase (async, don't block forwarding)
    this.storeChunkToSupabase(message).catch(error => {
      console.error(`Failed to store chunk ${message.chunkIndex} to Supabase:`, error);
      // Don't throw - continue forwarding even if storage fails
    });

    // 2. Forward chunk to all recruiters watching this session
    const recruiters = sessionClients 
      ? Array.from(sessionClients).filter(c => c.clientType === 'recruiter')
      : [];
    
    const base64Data = message.data;
    
    for (const recruiter of recruiters) {
      if (recruiter.ws.readyState === WebSocket.OPEN) {
        recruiter.ws.send(JSON.stringify({
          type: 'video-chunk',
          chunkIndex: message.chunkIndex,
          streamType: message.streamType,
          data: base64Data
        }));
      }
    }

    console.log(`Broadcasted ${message.streamType} chunk ${message.chunkIndex} to ${recruiters.length} recruiters`);
  }

  /**
   * Store video chunk to Supabase storage and database
   * This serves as a backup to HTTP uploads from the frontend
   */
  private async storeChunkToSupabase(message: VideoChunkMessage) {
    if (!supabase) {
      console.warn('Supabase not configured, skipping chunk storage');
      return;
    }

    try {
      // Fetch session details to get company/job/candidate info for file path
      const session = await prisma.session.findUnique({
        where: { id: message.sessionId },
        include: {
          assessment: {
            include: {
              company: true
            }
          }
        }
      });

      if (!session) {
        console.warn(`Session ${message.sessionId} not found, skipping chunk storage`);
        return;
      }

      // SECURITY: Only store chunks for recruiter assessments
      if (session.assessment?.assessmentType === 'candidate') {
        console.log(`Skipping chunk storage for candidate assessment ${message.sessionId}`);
        return;
      }

      // Get company name, job name, and candidate name for folder structure
      const companyName = session.assessment?.company?.name || 'UnknownCompany';
      const jobName = session.assessment?.jobTitle || session.assessment?.role || 'UnknownJob';
      const candidateName = session.candidateName || session.sessionCode || 'UnknownCandidate';
      const streamTypeForPath = message.streamType;

      // Build file path using same structure as HTTP upload endpoint
      // Use current timestamp (same as HTTP endpoint) - each chunk gets unique filename
      // This ensures chunks are stored even if HTTP uploads fail
      const timestamp = Date.now();
      const filePath = buildVideoChunkPath(
        companyName,
        jobName,
        candidateName,
        streamTypeForPath,
        message.chunkIndex,
        timestamp
      );

      // Convert base64 to buffer
      const buffer = Buffer.from(message.data, 'base64');

      // Validate chunk size (skip empty chunks)
      if (buffer.length === 0) {
        console.warn(`Skipping empty chunk ${message.chunkIndex} for ${message.streamType}`);
        return;
      }

      // Check if chunk already exists in database (might have been uploaded via HTTP)
      const existingChunk = await prisma.videoChunk.findFirst({
        where: {
          sessionId: message.sessionId,
          chunkIndex: message.chunkIndex
        }
      });

      let url: string;

      if (existingChunk && existingChunk.url) {
        // Chunk already uploaded via HTTP - use existing URL and skip storage
        console.log(`Chunk ${message.chunkIndex} already exists in database (uploaded via HTTP), skipping WebSocket storage`);
        url = existingChunk.url;
      } else {
        // Upload to Supabase Storage (chunk not yet uploaded)
        const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'video';
        
        console.log(`📦 Storing ${message.streamType} chunk ${message.chunkIndex} to Supabase: ${filePath} (${buffer.length} bytes)`);

        const { data: uploadData, error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(filePath, buffer, {
            contentType: 'video/webm',
            upsert: false // Don't overwrite existing chunks
          });

        if (uploadError) {
          // If file already exists, try to get its URL
          if (uploadError.message?.includes('already exists') || uploadError.message?.includes('duplicate')) {
            console.log(`Chunk ${message.chunkIndex} file already exists in storage, getting URL`);
            const { data: urlData } = supabase.storage
              .from(bucket)
              .getPublicUrl(filePath);
            url = urlData.publicUrl;
          } else {
            throw uploadError;
          }
        } else {
          console.log(`✅ Stored ${message.streamType} chunk ${message.chunkIndex} to Supabase: ${filePath}`);
          
          // Get public URL
          const { data: urlData } = supabase.storage
            .from(bucket)
            .getPublicUrl(filePath);
          url = urlData.publicUrl;
        }
      }

      // Save metadata to database (idempotent - use existingChunk from above)
      try {
        if (existingChunk) {
          // Update existing chunk (in case URL changed or size updated)
          await prisma.videoChunk.update({
            where: { id: existingChunk.id },
            data: {
              url, // Update URL in case it changed
              sizeBytes: BigInt(buffer.length)
            }
          });
          console.log(`✅ Updated chunk ${message.chunkIndex} metadata in database`);
        } else {
          // Create new chunk record
          await prisma.videoChunk.create({
            data: {
              sessionId: message.sessionId,
              chunkIndex: message.chunkIndex,
              url,
              sizeBytes: BigInt(buffer.length)
            }
          });
          console.log(`✅ Saved chunk ${message.chunkIndex} metadata to database`);
        }
      } catch (dbError: any) {
        // Log but don't fail - file is in Supabase
        console.error(`Failed to save chunk ${message.chunkIndex} metadata to database:`, dbError);
      }

    } catch (error: any) {
      console.error(`Error storing chunk ${message.chunkIndex} to Supabase:`, error);
      // Don't throw - continue processing even if storage fails
    }
  }

  private handleDisconnect(ws: WebSocket) {
    // Remove from all sessions
    for (const [sessionId, clients] of this.clients.entries()) {
      for (const client of clients) {
        if (client.ws === ws) {
          clients.delete(client);
          console.log(`Removed ${client.clientType} from session ${sessionId}`);
          
          // Clean up empty sessions
          if (clients.size === 0) {
            this.clients.delete(sessionId);
          }
          
          // Also remove from sessions array
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

