/**
 * MCP Client - Core MCP Protocol Implementation
 * 
 * Provides a Node.js client for communicating with MCP servers
 * using the Model Context Protocol (JSON-RPC over stdio).
 * 
 * Supports both:
 * - Local spawn (development): Spawns Python processes directly
 * - Docker exec (production): Executes in Docker containers
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import Docker from 'dockerode';
import { logger } from '../lib/logger';

/**
 * Read a .env file and return its key=value pairs as a plain object.
 * Does NOT modify process.env — just parses the file.
 */
function readDotEnv(envFilePath: string): Record<string, string> {
  if (!fs.existsSync(envFilePath)) return {};
  const vars: Record<string, string> = {};
  const lines = fs.readFileSync(envFilePath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) vars[key] = val;
  }
  return vars;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
}

/**
 * Common interface implemented by both MCPClient (stdio/docker) and MCPHttpClient (HTTP).
 * Callers (serverA/B/C.ts) only depend on this interface.
 */
export interface IMCPClient {
  callTool(toolName: string, arguments_: any): Promise<any>;
  getTools(): MCPTool[];
  stop(): void;
}

// Docker connection (same as template-builder.ts)
const dockerOptions: any = {};
if (process.platform === 'darwin') {
  const macPaths = [
    process.env.DOCKER_HOST?.replace('unix://', ''),
    `${process.env.HOME}/.docker/run/docker.sock`,
    '/var/run/docker.sock'
  ].filter(Boolean);
  
  for (const socketPath of macPaths) {
    if (socketPath && fs.existsSync(socketPath)) {
      dockerOptions.socketPath = socketPath;
      break;
    }
  }
  
  if (!dockerOptions.socketPath) {
    dockerOptions.socketPath = '/var/run/docker.sock';
  }
} else if (process.platform === 'win32') {
  dockerOptions.socketPath = process.env.DOCKER_HOST || '//./pipe/docker_engine';
} else {
  dockerOptions.socketPath = '/var/run/docker.sock';
}

const docker = new Docker(dockerOptions);

/**
 * MCP Client for communicating with Python MCP servers via stdio
 */
export class MCPClient extends EventEmitter implements IMCPClient {
  private process: ChildProcess | null = null;
  private dockerExec: any = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private buffer = '';
  private serverPath: string;
  private containerName: string | null;
  private tools: MCPTool[] = [];
  private initialized = false;
  private useDocker: boolean;

  constructor(serverPath: string, containerName?: string) {
    super();
    this.serverPath = serverPath;
    this.containerName = containerName || null;
    // Use Docker if container name is provided, otherwise use local spawn
    this.useDocker = !!containerName;
  }

  /**
   * Start the MCP server process
   */
  async start(): Promise<void> {
    if (this.useDocker && this.containerName) {
      return this.startDocker();
    } else {
      return this.startLocal();
    }
  }

  /**
   * Start MCP server using Docker exec
   */
  private async startDocker(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // Get container
        const container = docker.getContainer(this.containerName!);
        
        // Check if container exists and is running
        const containerInfo = await container.inspect();
        if (containerInfo.State.Status !== 'running') {
          throw new Error(`Container ${this.containerName} is not running`);
        }

        // Create exec instance
        const exec = await container.exec({
          Cmd: ['python3', 'src/server.py'],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Env: ['PYTHONUNBUFFERED=1']
        });

        // Start the exec instance
        const stream = await exec.start({
          hijack: true,
          stdin: true
        });

        // Handle data from Docker exec stream
        // Docker uses multiplexed stream: [8-byte header][data]
        // Header: [stream_type(1 byte)][reserved(3 bytes)][size(4 bytes)]
        let buffer = Buffer.alloc(0);
        
        stream.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          
          // Process complete frames
          while (buffer.length >= 8) {
            const streamType = buffer[0];
            const size = buffer.readUInt32BE(4);
            
            if (buffer.length < 8 + size) {
              // Incomplete frame, wait for more data
              break;
            }
            
            const data = buffer.slice(8, 8 + size);
            buffer = buffer.slice(8 + size);
            
            if (streamType === 1) {
              // stdout - MCP protocol messages
              this.buffer += data.toString();
              this.processBuffer();
            } else if (streamType === 2) {
              // stderr - log it
              const logLines = data.toString().split('\n').filter(line => line.trim());
              logLines.forEach(line => {
                if (line.includes('ERROR:')) {
                  logger.error(`[MCP Server ${this.containerName}] ${line}`);
                } else if (line.includes('WARNING:') || line.includes('WARN:')) {
                  logger.warn(`[MCP Server ${this.containerName}] ${line}`);
                } else {
                  logger.log(`[MCP Server ${this.containerName}] ${line}`);
                }
              });
            }
          }
        });

        stream.on('end', () => {
          this.emit('exit', 0);
        });

        stream.on('error', (error: Error) => {
          logger.error(`[MCP Client] Docker exec error: ${error.message}`);
          reject(error);
        });

        // Store stream for writing
        this.dockerExec = { exec, stream };

        // Initialize MCP connection
        this.initialize()
          .then(() => {
            this.initialized = true;
            resolve();
          })
          .catch(reject);

      } catch (error: any) {
        reject(new Error(`Failed to start MCP server in container ${this.containerName}: ${error.message}`));
      }
    });
  }

  /**
   * Start MCP server using local spawn (development)
   */
  private async startLocal(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Determine Python executable (use venv if available, else system python3)
      const serverDir = path.dirname(this.serverPath);
      const venvPython = path.join(serverDir, '..', 'venv', 'bin', 'python');
      const pythonExec = fs.existsSync(venvPython) ? venvPython : 'python3';
      
      // Load the MCP server's own .env so its Azure credentials always win
      // over anything the backend process.env might have (e.g. a different OPENAI_API_KEY)
      const serverEnvFile = path.join(serverDir, '..', '.env');
      const serverEnvVars = readDotEnv(serverEnvFile);
      if (Object.keys(serverEnvVars).length > 0) {
        logger.log(`[MCP Client] Loaded ${Object.keys(serverEnvVars).length} vars from ${serverEnvFile}`);
      }

      // Spawn Python process — server .env vars override backend process.env
      this.process = spawn(pythonExec, [this.serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', ...serverEnvVars }
      });

      // Handle stdout (responses from server)
      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      // Handle stderr (errors/logs)
      this.process.stderr?.on('data', (data: Buffer) => {
        const logLines = data.toString().split('\n').filter(line => line.trim());
        logLines.forEach(line => {
          if (line.includes('ERROR:')) {
            logger.error(`[MCP Server] ${line}`);
          } else if (line.includes('WARNING:') || line.includes('WARN:')) {
            logger.warn(`[MCP Server] ${line}`);
          } else {
            // INFO, DEBUG, and other logs
            logger.log(`[MCP Server] ${line}`);
          }
        });
      });

      // Handle process exit
      this.process.on('exit', (code) => {
        this.emit('exit', code);
        if (code !== 0) {
          reject(new Error(`MCP server exited with code ${code}`));
        }
      });

      // Initialize MCP connection
      this.initialize()
        .then(() => {
          this.initialized = true;
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Initialize MCP connection (send initialize request)
   */
  private async initialize(): Promise<void> {
    const initRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'promora-backend',
          version: '1.0.0'
        }
      }
    };

    await this.sendRequest(initRequest);
    
    // Send initialized notification
    const initializedNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    };
    
    await this.sendNotification(initializedNotification);
    
    // List tools
    await this.refreshTools();
  }

  /**
   * Refresh available tools from server
   */
  async refreshTools(): Promise<void> {
    const request = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'tools/list'
    };

    const response = await this.sendRequest(request);
    this.tools = response.tools || [];
  }

  /**
   * Call a tool on the MCP server
   */
  async callTool(toolName: string, arguments_: any): Promise<any> {
    if (!this.initialized) {
      throw new Error('MCP client not initialized. Call start() first.');
    }

    const request = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: arguments_
      }
    };

    const response = await this.sendRequest(request);
    
    // Extract text content from response
    if (response.content && Array.isArray(response.content)) {
      const textContent = response.content.find((c: any) => c.type === 'text');
      if (textContent) {
        try {
          return JSON.parse(textContent.text);
        } catch (e) {
          return textContent.text;
        }
      }
    }
    
    return response;
  }

  /**
   * Get available tools
   */
  getTools(): MCPTool[] {
    return this.tools;
  }

  /**
   * Send JSON-RPC request
   */
  private async sendRequest(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = request.id;
      this.pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify(request) + '\n';
      
      if (this.useDocker && this.dockerExec) {
        // Docker exec: write to stream with Docker protocol header
        // Format: [stream_type(1)][reserved(3)][size(4)][data]
        const buffer = Buffer.alloc(8 + message.length);
        buffer[0] = 0; // stdin stream type
        buffer.writeUInt32BE(0, 1); // Reserved (3 bytes, but we use 1-4)
        buffer.writeUInt32BE(message.length, 4); // Size
        buffer.write(message, 8); // Data
        
        this.dockerExec.stream.write(buffer, (err: Error | null) => {
          if (err) {
            this.pendingRequests.delete(id);
            reject(err);
          }
        });
      } else if (this.process) {
        // Local spawn: write to stdin
        this.process.stdin?.write(message, (err) => {
          if (err) {
            this.pendingRequests.delete(id);
            reject(err);
          }
        });
      } else {
        this.pendingRequests.delete(id);
        reject(new Error('MCP client not started'));
      }
    });
  }

  /**
   * Send JSON-RPC notification (no response expected)
   */
  private async sendNotification(notification: any): Promise<void> {
    const message = JSON.stringify(notification) + '\n';
    return new Promise((resolve, reject) => {
      if (this.useDocker && this.dockerExec) {
        // Docker exec: write to stream with Docker protocol header
        const buffer = Buffer.alloc(8 + message.length);
        buffer[0] = 0; // stdin stream type
        buffer.writeUInt32BE(0, 1); // Reserved
        buffer.writeUInt32BE(message.length, 4); // Size
        buffer.write(message, 8); // Data
        
        this.dockerExec.stream.write(buffer, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      } else if (this.process) {
        this.process.stdin?.write(message, (err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        reject(new Error('MCP client not started'));
      }
    });
  }

  /**
   * Process incoming data buffer
   */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        this.handleMessage(message);
      } catch (e) {
        logger.error(`[MCP Client] Failed to parse message: ${line}`);
      }
    }
  }

  /**
   * Handle incoming JSON-RPC message
   */
  private handleMessage(message: any): void {
    if (message.id !== undefined) {
      // Response to a request
      const request = this.pendingRequests.get(message.id);
      if (request) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          request.reject(new Error(message.error.message || 'MCP error'));
        } else {
          request.resolve(message.result);
        }
      }
    } else if (message.method) {
      // Notification from server
      this.emit('notification', message);
    }
  }

  /**
   * Get next request ID
   */
  private getNextRequestId(): number {
    return ++this.requestId;
  }

  /**
   * Stop the MCP server
   */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this.dockerExec && this.dockerExec.stream) {
      this.dockerExec.stream.end();
      this.dockerExec = null;
    }
    this.initialized = false;
  }
}

/**
 * MCPHttpClient - HTTP REST client for deployed MCP servers.
 *
 * Used in production when MCP_USE_HTTP=true.  Each Python MCP server exposes:
 *   GET  /health      → { status, server }
 *   GET  /tools       → { tools: [...] }
 *   POST /call_tool   → { result } | { error }
 *
 * Server B (template builder) runs LLM generation that takes 2-3 min, so its
 * timeout is set to 5 minutes; A and C default to 60 s.
 */
export class MCPHttpClient implements IMCPClient {
  private baseUrl: string;
  private tools: MCPTool[] = [];
  private initialized = false;
  private timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 60_000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async start(): Promise<void> {
    // Health check (10 s timeout)
    const hc = new AbortController();
    const hcTimer = setTimeout(() => hc.abort(), 10_000);
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: hc.signal });
      if (!res.ok) throw new Error(`MCP HTTP server unhealthy at ${this.baseUrl} (${res.status})`);
    } finally {
      clearTimeout(hcTimer);
    }

    // Load tool list
    const toolsRes = await fetch(`${this.baseUrl}/tools`);
    if (!toolsRes.ok) throw new Error(`Failed to list tools from ${this.baseUrl} (${toolsRes.status})`);
    const toolsData = await toolsRes.json();
    this.tools = toolsData.tools || [];
    this.initialized = true;
    logger.log(`[MCPHttpClient] Connected to ${this.baseUrl} — ${this.tools.length} tools`);
  }

  async callTool(toolName: string, arguments_: any): Promise<any> {
    if (!this.initialized) throw new Error('MCPHttpClient not initialized. Call start() first.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/call_tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: toolName, arguments: arguments_ }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} from MCP server: ${text}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  stop(): void {
    this.initialized = false;
  }
}

/**
 * MCP Client Manager - Manages multiple MCP server connections
 */
export class MCPClientManager {
  private clients = new Map<string, IMCPClient>();
  private basePath: string;
  private useDocker: boolean;
  private containerPrefix: string;
  private serverUrls: Record<string, string> | null;

  constructor(
    basePath: string,
    useDocker: boolean = false,
    containerPrefix: string = 'promora-mcp-server',
    serverUrls: Record<string, string> | null = null,
  ) {
    this.basePath = basePath;
    this.useDocker = useDocker;
    this.containerPrefix = containerPrefix;
    this.serverUrls = serverUrls;
  }

  /**
   * Get or create MCP client for a server
   */
  async getClient(serverName: 'server-a-job-analysis' | 'server-b-template-builder' | 'server-c-monitoring'): Promise<IMCPClient> {
    const serverKey = serverName;

    if (!this.clients.has(serverKey)) {
      let client: IMCPClient;

      if (this.serverUrls) {
        // HTTP mode — used in deployment; each MCP server runs as its own service
        const url = this.serverUrls[serverName];
        if (!url) throw new Error(`No HTTP URL configured for MCP server: ${serverName}`);
        // Server B runs LLM generation (~2-3 min) so give it a 5-minute timeout
        const timeoutMs = serverName === 'server-b-template-builder' ? 300_000 : 60_000;
        client = new MCPHttpClient(url, timeoutMs);
      } else if (this.useDocker) {
        // Docker exec mode (stdio over docker exec stream)
        const containerName = this.getContainerName(serverName);
        client = new MCPClient('', containerName);
      } else {
        // Local spawn mode — default for local dev
        const serverPath = path.join(this.basePath, serverName, 'src', 'server.py');
        if (!fs.existsSync(serverPath)) {
          throw new Error(`MCP server not found: ${serverPath}`);
        }
        client = new MCPClient(serverPath);
      }

      await client.start();
      this.clients.set(serverKey, client);
    }

    return this.clients.get(serverKey)!;
  }

  /**
   * Get container name for server
   */
  private getContainerName(serverName: string): string {
    const nameMap: Record<string, string> = {
      'server-a-job-analysis': 'promora-mcp-server-a',
      'server-b-template-builder': 'promora-mcp-server-b',
      'server-c-monitoring': 'promora-mcp-server-c'
    };
    return nameMap[serverName] || `${this.containerPrefix}-${serverName}`;
  }

  /**
   * Stop all clients
   */
  stopAll(): void {
    for (const client of this.clients.values()) {
      client.stop();
    }
    this.clients.clear();
  }
}

// Singleton instance
let clientManager: MCPClientManager | null = null;

/**
 * Get the global MCP client manager
 */
export function getMCPClientManager(): MCPClientManager {
  if (!clientManager) {
    const useHttp   = process.env.MCP_USE_HTTP === 'true';
    const useDocker = process.env.MCP_USE_DOCKER === 'true';

    if (useHttp) {
      // ── HTTP mode (deployment) ────────────────────────────────────────────
      // Each MCP server runs as its own container/service and exposes a REST API.
      // Set MCP_SERVER_A_URL / _B_URL / _C_URL in the backend's .env (or Docker Compose).
      const serverUrls: Record<string, string> = {
        'server-a-job-analysis':     process.env.MCP_SERVER_A_URL || 'http://localhost:8001',
        'server-b-template-builder': process.env.MCP_SERVER_B_URL || 'http://localhost:8002',
        'server-c-monitoring':       process.env.MCP_SERVER_C_URL || 'http://localhost:8003',
      };
      logger.log('[MCP Client] Using HTTP transport for MCP servers');
      logger.log(`[MCP Client] Server A → ${serverUrls['server-a-job-analysis']}`);
      logger.log(`[MCP Client] Server B → ${serverUrls['server-b-template-builder']}`);
      logger.log(`[MCP Client] Server C → ${serverUrls['server-c-monitoring']}`);
      clientManager = new MCPClientManager('', false, '', serverUrls);

    } else if (useDocker) {
      // ── Docker exec mode ─────────────────────────────────────────────────
      // MCP servers run inside Docker containers; communicate via docker exec + stdio.
      logger.log('[MCP Client] Using Docker exec for MCP servers');
      clientManager = new MCPClientManager('', true, 'promora-mcp-server');

    } else {
      // ── Local spawn mode (default for local dev) ──────────────────────────
      const backendDir = process.cwd();
      const projectRoot = path.resolve(backendDir, '..');
      const mcpServersPath = path.join(projectRoot, 'mcp-servers');

      logger.log(`[MCP Client] Backend dir: ${backendDir}`);
      logger.log(`[MCP Client] Using local spawn for MCP servers at: ${mcpServersPath}`);

      const serverAPath = path.join(mcpServersPath, 'server-a-job-analysis/src/server.py');
      const serverAExists = fs.existsSync(serverAPath);
      logger.log(`[MCP Client] Server A exists: ${serverAExists} at ${serverAPath}`);

      if (!serverAExists) {
        throw new Error(`MCP server not found at: ${serverAPath}`);
      }

      clientManager = new MCPClientManager(mcpServersPath, false);
    }
  }
  return clientManager;
}