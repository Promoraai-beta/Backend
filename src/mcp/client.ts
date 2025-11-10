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

interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
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
export class MCPClient extends EventEmitter {
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
      
      // Spawn Python process
      this.process = spawn(pythonExec, [this.serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
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
 * MCP Client Manager - Manages multiple MCP server connections
 */
export class MCPClientManager {
  private clients = new Map<string, MCPClient>();
  private basePath: string;
  private useDocker: boolean;
  private containerPrefix: string;

  constructor(basePath: string, useDocker: boolean = false, containerPrefix: string = 'promora-mcp-server') {
    this.basePath = basePath;
    this.useDocker = useDocker;
    this.containerPrefix = containerPrefix;
  }

  /**
   * Get or create MCP client for a server
   */
  async getClient(serverName: 'server-a-job-analysis' | 'server-b-template-builder' | 'server-c-monitoring'): Promise<MCPClient> {
    const serverKey = serverName;
    
    if (!this.clients.has(serverKey)) {
      let client: MCPClient;

      if (this.useDocker) {
        // Use Docker containers
        const containerName = this.getContainerName(serverName);
        client = new MCPClient('', containerName); // Path not needed for Docker
      } else {
        // Use local spawn
        const serverPath = path.join(this.basePath, serverName, 'src', 'server.py');
        
        // Check if server file exists
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
    // Check if we should use Docker (production) or local spawn (development)
    const useDocker = process.env.MCP_USE_DOCKER === 'true' || process.env.NODE_ENV === 'production';
    
    if (useDocker) {
      // Docker mode: containers are already running
      logger.log('[MCP Client] Using Docker containers for MCP servers');
      clientManager = new MCPClientManager('', true, 'promora-mcp-server');
    } else {
      // Local mode: spawn Python processes
      const backendDir = process.cwd();
      const projectRoot = path.resolve(backendDir, '..');
      const mcpServersPath = path.join(projectRoot, 'MCP-Servers');
      
      // Debug logging
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