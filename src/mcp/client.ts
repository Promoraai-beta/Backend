/**
 * MCP Client - Core MCP Protocol Implementation
 * 
 * Provides a Node.js client for communicating with MCP servers
 * using the Model Context Protocol (JSON-RPC over stdio).
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
}

/**
 * MCP Client for communicating with Python MCP servers via stdio
 */
export class MCPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private buffer = '';
  private serverPath: string;
  private tools: MCPTool[] = [];
  private initialized = false;

  constructor(serverPath: string) {
    super();
    this.serverPath = serverPath;
  }

  /**
   * Start the MCP server process
   */
  async start(): Promise<void> {
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
      // Python logs to stderr by default, so we need to parse log levels
      this.process.stderr?.on('data', (data: Buffer) => {
        const logLines = data.toString().split('\n').filter(line => line.trim());
        logLines.forEach(line => {
          // Parse Python logging format: LEVEL:module:message
          if (line.includes('ERROR:')) {
            console.error(`[MCP Server] ${line}`);
          } else if (line.includes('WARNING:') || line.includes('WARN:')) {
            console.warn(`[MCP Server] ${line}`);
          } else {
            // INFO, DEBUG, and other logs
            console.log(`[MCP Server] ${line}`);
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
      this.process?.stdin?.write(message, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Send JSON-RPC notification (no response expected)
   */
  private async sendNotification(notification: any): Promise<void> {
    const message = JSON.stringify(notification) + '\n';
    return new Promise((resolve, reject) => {
      this.process?.stdin?.write(message, (err) => {
        if (err) reject(err);
        else resolve();
      });
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
        console.error(`[MCP Client] Failed to parse message: ${line}`);
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
      this.initialized = false;
    }
  }
}

/**
 * MCP Client Manager - Manages multiple MCP server connections
 */
export class MCPClientManager {
  private clients = new Map<string, MCPClient>();
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Get or create MCP client for a server
   */
  async getClient(serverName: 'server-a-job-analysis' | 'server-b-template-builder' | 'server-c-monitoring'): Promise<MCPClient> {
    const serverKey = serverName;
    
    if (!this.clients.has(serverKey)) {
      const serverPath = path.join(this.basePath, serverName, 'src', 'server.py');
      
      // Check if server file exists
      if (!fs.existsSync(serverPath)) {
        throw new Error(`MCP server not found: ${serverPath}`);
      }

      const client = new MCPClient(serverPath);
      await client.start();
      this.clients.set(serverKey, client);
    }

    return this.clients.get(serverKey)!;
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
    // MCP servers are at project root level (sibling to backend/)
    // Use process.cwd() which is the working directory when server starts
    // This works for both dev (ts-node from backend/) and production (node from backend/)
    const backendDir = process.cwd(); // Should be /path/to/AI Watcher/backend
    const projectRoot = path.resolve(backendDir, '..'); // /path/to/AI Watcher
    const mcpServersPath = path.join(projectRoot, 'mcp-servers');
    
    // Debug logging
    console.log(`[MCP Client] Backend dir: ${backendDir}`);
    console.log(`[MCP Client] Looking for servers at: ${mcpServersPath}`);
    
    const serverAPath = path.join(mcpServersPath, 'server-a-job-analysis/src/server.py');
    const serverAExists = fs.existsSync(serverAPath);
    console.log(`[MCP Client] Server A exists: ${serverAExists} at ${serverAPath}`);
    
    if (!serverAExists) {
      throw new Error(`MCP server not found at: ${serverAPath}`);
    }
    
    clientManager = new MCPClientManager(mcpServersPath);
  }
  return clientManager;
}

