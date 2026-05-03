/**
 * Local Docker Provisioner Service
 * Creates and manages local Docker containers for assessment sessions
 */

import Docker from 'dockerode';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../lib/logger';
import { fileServerToken } from '../lib/container-token';

export interface ContainerProvisionResult {
  containerId: string;
  containerGroupName: string;
  fqdn: string;
  codeServerUrl: string;
  status: 'provisioning' | 'running';
  terminalUrl?: string;
}

// Docker connection - handles both Linux and macOS/Windows (Docker Desktop)
const dockerOptions: any = {};
if (process.platform === 'darwin') {
  // macOS Docker Desktop - try multiple possible paths
  const macPaths = [
    process.env.DOCKER_HOST?.replace('unix://', ''),
    `${process.env.HOME}/.docker/run/docker.sock`,
    '/var/run/docker.sock'
  ].filter(Boolean);
  
  // Try to find the first existing socket
  for (const socketPath of macPaths) {
    if (socketPath && existsSync(socketPath)) {
      dockerOptions.socketPath = socketPath;
      logger.log(`🐳 [Local Docker] Using Docker socket: ${socketPath}`);
      break;
    }
  }
  
  // Default fallback for macOS
  if (!dockerOptions.socketPath) {
    dockerOptions.socketPath = '/var/run/docker.sock';
  }
} else if (process.platform === 'win32') {
  // Windows Docker Desktop uses named pipe
  dockerOptions.socketPath = process.env.DOCKER_HOST || '//./pipe/docker_engine';
} else {
  // Linux - default socket path
  dockerOptions.socketPath = '/var/run/docker.sock';
}

const docker = new Docker(dockerOptions);

// Local Docker image name (should be built from container/Dockerfile)
// These are read lazily inside functions so that dotenv (loaded later in server.ts)
// takes effect before they are used, and shell env vars don't win by being baked at
// module-load time. Always default to loopback values to prevent DNS errors.
const getLocalImage = () => process.env.LOCAL_DOCKER_IMAGE || 'assessment:latest';
const getLocalHost  = () => {
  const h = process.env.LOCAL_DOCKER_HOST || 'localhost';
  // Reject obviously wrong hostnames (e.g. Docker network names that aren't routable
  // from the host) and fall back to loopback so the health check never DNS-fails.
  if (h === 'containers' || h === 'host.docker.internal') return '127.0.0.1';
  return h;
};

// Port mapping - find available ports dynamically
let nextPort = 18080; // Start from 18080 to avoid conflicts with other services
const usedPorts = new Set<number>();

/**
 * Get all ports currently in use by Docker containers
 */
async function getUsedDockerPorts(): Promise<Set<number>> {
  const ports = new Set<number>();
  try {
    const containers = await docker.listContainers({ all: true });
    for (const container of containers) {
      if (container.Ports) {
        for (const portMapping of container.Ports) {
          if (portMapping.PublicPort) {
            ports.add(portMapping.PublicPort);
          }
        }
      }
    }
  } catch (error: any) {
    logger.warn('[Local Docker] Failed to list containers for port check:', error.message);
  }
  return ports;
}

/**
 * Check if a port is actually available (not in use by Docker or in-memory tracking)
 */
async function isPortAvailable(port: number): Promise<boolean> {
  // Check in-memory tracking
  if (usedPorts.has(port)) {
    return false;
  }
  
  // Check Docker containers
  const dockerPorts = await getUsedDockerPorts();
  if (dockerPorts.has(port)) {
    return false;
  }
  
  return true;
}

/**
 * Get an available port, checking both in-memory tracking and actual Docker containers
 */
async function getAvailablePort(): Promise<number> {
  let attempts = 0;
  const maxAttempts = 100; // Prevent infinite loops
  
  while (attempts < maxAttempts) {
    // Check if current port is available
    if (await isPortAvailable(nextPort)) {
      usedPorts.add(nextPort);
      const port = nextPort;
      nextPort++;
      return port;
    }
    
    // Port is in use, try next one
    nextPort++;
    attempts++;
  }
  
  throw new Error(`Failed to find available port after ${maxAttempts} attempts. Please clean up old containers.`);
}

function releasePort(port: number): void {
  usedPorts.delete(port);
}

/**
 * Initialize port tracking by scanning existing containers
 */
async function initializePortTracking(): Promise<void> {
  try {
    const dockerPorts = await getUsedDockerPorts();
    for (const port of dockerPorts) {
      if (port >= 18080 && port < 20000) { // Only track our port range
        usedPorts.add(port);
        if (port >= nextPort) {
          nextPort = port + 1;
        }
      }
    }
    logger.log(`[Local Docker] Initialized port tracking: ${usedPorts.size} ports in use, next port: ${nextPort}`);
  } catch (error: any) {
    logger.warn('[Local Docker] Failed to initialize port tracking:', error.message);
  }
}

// Initialize port tracking on module load
initializePortTracking().catch(err => {
  logger.warn('[Local Docker] Port tracking initialization failed:', err);
});

/**
 * Provision a local Docker container for an assessment session
 */
export async function provisionLocalContainer(
  sessionId: string,
  templateFiles?: Record<string, string>
): Promise<ContainerProvisionResult> {
  let idePort: number | undefined;
  let terminalPort: number | undefined;
  let previewPort: number | undefined;
  let currentIdePort: number | undefined;
  let currentTerminalPort: number | undefined;
  let currentPreviewPort: number | undefined;
  
  try {
    // Generate unique container name
    const timestamp = Date.now();
    const shortSessionId = sessionId.replace(/-/g, '').slice(0, 8);
    const containerName = `promora-${shortSessionId}-${timestamp}`;

    logger.log(`[Local Docker] Provisioning container for session ${sessionId}: ${containerName}`);

    // Get available ports (async now)
    idePort = await getAvailablePort();
    terminalPort = await getAvailablePort();
    previewPort = await getAvailablePort();

    logger.log(`[Local Docker] Allocated ports - IDE: ${idePort}, Terminal: ${terminalPort}, Preview: ${previewPort}`);

    // Check if image exists
    try {
      await docker.getImage(getLocalImage()).inspect();
    } catch (error: any) {
      throw new Error(
        `Docker image '${getLocalImage()}' not found. Please build it first: ` +
        `cd container && docker build -t ${getLocalImage()} .`
      );
    }

    // Prepare template.json if template files are provided
    let templateJsonPath: string | undefined;
    if (templateFiles && Object.keys(templateFiles).length > 0) {
      // Create temp directory for template file
      const tempDir = join(process.cwd(), 'temp', 'templates');
      mkdirSync(tempDir, { recursive: true });
      templateJsonPath = join(tempDir, `${sessionId}-template.json`);
      
      // Create template.json structure
      const templateJson = {
        name: 'Assessment Template',
        files: templateFiles
      };
      
      writeFileSync(templateJsonPath, JSON.stringify(templateJson, null, 2));
      logger.log(`[Local Docker] Created template.json at ${templateJsonPath} with ${Object.keys(templateFiles).length} files`);
    }

    // Prepare volume mounts
    const binds: string[] = [];
    if (templateJsonPath) {
      binds.push(`${templateJsonPath}:/home/candidate/template.json:ro`);
    }

    // Create container with retry logic for port conflicts
    let container;
    currentIdePort = idePort;
    currentTerminalPort = terminalPort;
    currentPreviewPort = previewPort;
    const allocatedPorts: number[] = [idePort, terminalPort, previewPort]; // Track all allocated ports for cleanup
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
      try {
        container = await docker.createContainer({
          Image: getLocalImage(),
          name: containerName,
          ExposedPorts: {
            '8080/tcp': {},
            '7681/tcp': {},
            '5173/tcp': {},
            '9090/tcp': {},
          },
          HostConfig: {
            PortBindings: {
              '8080/tcp': [{ HostPort: currentIdePort.toString() }],
              '7681/tcp': [{ HostPort: currentTerminalPort.toString() }],
              '5173/tcp': [{ HostPort: currentPreviewPort!.toString() }],
            },
            AutoRemove: false, // We'll manage cleanup manually
            RestartPolicy: { Name: 'no' },
            Binds: binds.length > 0 ? binds : undefined
          },
          Env: [
            `SESSION_ID=${sessionId}`,
            `FILE_SERVER_TOKEN=${fileServerToken(sessionId)}`,
            'VSCODE_DISABLE_WORKSPACE_TRUST=1',
            'VSCODE_DISABLE_TRUST_WORKSPACE_PROMPT=1'
          ],
          Tty: false,
          OpenStdin: false
        });
        break; // Success, exit retry loop
      } catch (error: any) {
        // Check if it's a port conflict error
        const isPortConflict = error.message?.includes('port is already allocated') || 
                               error.message?.includes('Bind for') ||
                               (error.statusCode === 500 && error.message?.includes('port'));
        
        if (isPortConflict && retries < maxRetries - 1) {
          retries++;
          // Release old ports and get new ones
          releasePort(currentIdePort);
          releasePort(currentTerminalPort);
          releasePort(currentPreviewPort!);
          currentIdePort = await getAvailablePort();
          currentTerminalPort = await getAvailablePort();
          currentPreviewPort = await getAvailablePort();
          allocatedPorts.push(currentIdePort, currentTerminalPort, currentPreviewPort);
          logger.warn(`[Local Docker] Port conflict detected (attempt ${retries}/${maxRetries}), retrying with new ports: ${currentIdePort}, ${currentTerminalPort}`);
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          // Not a port conflict or max retries reached, throw error
          throw error;
        }
      }
    }

    if (!container) {
      // Release ports on failure
      releasePort(currentIdePort);
      releasePort(currentTerminalPort);
      throw new Error('Failed to create container after retries');
    }
    
    // Update port variables for later use
    const finalIdePort = currentIdePort;
    const finalTerminalPort = currentTerminalPort;
    const finalPreviewPort = currentPreviewPort!;

    // Start container
    await container.start();

    // Wait for code-server to be ready (it can take 5-10 seconds to fully start).
    // Always health-check via 127.0.0.1 (loopback) regardless of LOCAL_DOCKER_HOST —
    // port-mapped containers are always reachable via loopback on the host machine.
    // LOCAL_HOST is only used for the URL returned to the frontend (may differ in some
    // Docker network setups, but not for the health check).
    const codeServerUrl = `http://${getLocalHost()}:${finalIdePort}`;
    const healthCheckUrl = `http://127.0.0.1:${finalIdePort}`;
    const maxWaitMs = 15000;
    const pollIntervalMs = 500;
    let ready = false;
    for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      try {
        const res = await fetch(healthCheckUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          ready = true;
          logger.log(`[Local Docker] code-server ready after ${elapsed + pollIntervalMs}ms`);
          break;
        }
      } catch {
        // Not ready yet, continue waiting
      }
    }
    if (!ready) {
      logger.warn(`[Local Docker] code-server may not be fully ready after ${maxWaitMs}ms, returning URL anyway`);
    }

    // Check if container is running
    const containerInfo = await container.inspect();
    if (containerInfo.State.Status !== 'running') {
      throw new Error(`Container started but status is ${containerInfo.State.Status}`);
    }

    const terminalUrl = `http://${getLocalHost()}:${finalTerminalPort}`;
    const previewUrl  = `http://${getLocalHost()}:${finalPreviewPort}`;
    const containerId = container.id;

    logger.log(`[Local Docker] Container provisioned: ${containerName}, IDE: ${codeServerUrl}, Terminal: ${terminalUrl}, Preview: ${previewUrl}`);

    return {
      containerId,
      containerGroupName: containerName,
      fqdn: `${getLocalHost()}:${finalIdePort}`,
      codeServerUrl,
      status: 'running',
      terminalUrl,
      previewUrl,
    } as ContainerProvisionResult & { terminalUrl: string; previewUrl: string };
  } catch (error: any) {
    logger.error('[Local Docker] Container provision failed:', error);
    
    // Release all allocated ports on failure
    try {
      // Release original ports
      if (typeof idePort !== 'undefined') releasePort(idePort);
      if (typeof terminalPort !== 'undefined') releasePort(terminalPort);
      if (typeof previewPort !== 'undefined') releasePort(previewPort);
      // Release any retry ports (if retries happened)
      if (typeof currentIdePort !== 'undefined' && currentIdePort !== idePort) {
        releasePort(currentIdePort);
      }
      if (typeof currentTerminalPort !== 'undefined' && currentTerminalPort !== terminalPort) {
        releasePort(currentTerminalPort);
      }
      if (typeof currentPreviewPort !== 'undefined' && currentPreviewPort !== previewPort) {
        releasePort(currentPreviewPort);
      }

    } catch (releaseError) {
      // Ignore release errors
    }
    
    // If it's a port conflict, suggest cleanup
    if (error.message?.includes('port is already allocated') || 
        error.message?.includes('Bind for')) {
      throw new Error(
        `Port conflict: ${error.message}. ` +
        `Try cleaning up old containers: docker ps -a | grep promora | awk '{print $1}' | xargs docker rm -f`
      );
    }
    
    throw new Error(`Failed to provision local Docker container: ${error.message || error}`);
  }
}

/**
 * Delete a local Docker container
 */
export async function deleteLocalContainer(containerId: string): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
    const containerInfo = await container.inspect();
    
    // Extract ports from container info
    const ports = containerInfo.NetworkSettings?.Ports || {};
    const idePort = ports['8080/tcp']?.[0]?.HostPort;
    const terminalPort = ports['7681/tcp']?.[0]?.HostPort;
    
    if (idePort) releasePort(parseInt(idePort));
    if (terminalPort) releasePort(parseInt(terminalPort));

    // Stop and remove container
    try {
      await container.stop();
    } catch (error: any) {
      // Container might already be stopped
      if (!error.message?.includes('not running')) {
        logger.warn(`[Local Docker] Failed to stop container: ${error.message}`);
      }
    }

    await container.remove();
    logger.log(`[Local Docker] Container deleted: ${containerId}`);
  } catch (error: any) {
    // Don't throw - cleanup failures shouldn't break the flow
    if (error.statusCode === 404) {
      logger.warn(`[Local Docker] Container ${containerId} not found, already deleted`);
    } else {
      logger.error('[Local Docker] Container deletion failed:', error);
    }
  }
}

/**
 * Get local container status
 */
export async function getLocalContainerStatus(containerId: string): Promise<'running' | 'stopped' | 'not-found'> {
  try {
    const container = docker.getContainer(containerId);
    const containerInfo = await container.inspect();
    
    const state = containerInfo.State.Status?.toLowerCase() || '';
    if (state === 'running') return 'running';
    if (state === 'exited' || state === 'stopped') return 'stopped';
    return 'stopped';
  } catch (error: any) {
    if (error.statusCode === 404) {
      return 'not-found';
    }
    logger.error('[Local Docker] Failed to get container status:', error);
    return 'not-found';
  }
}

/**
 * Execute a command in a container and return stdout as a string.
 * Uses the Docker full-id from Prisma (containerId).
 */
export async function execInContainer(containerId: string, cmd: string[]): Promise<string> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise<string>((resolve, reject) => {
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      // Docker multiplexes stdout/stderr with an 8-byte header; strip it.
      if (chunk.length > 8) {
        output += chunk.slice(8).toString('utf8');
      } else {
        output += chunk.toString('utf8');
      }
    });
    stream.on('end', () => resolve(output));
    stream.on('error', reject);
  });
}

/**
 * Read a file from a running container's /workspace directory.
 */
const CONTAINER_WORKSPACE = '/home/candidate/workspace';

export async function readContainerFile(containerId: string, filePath: string): Promise<string> {
  const safePath = filePath.replace(/\.\./g, '').replace(/^\//, '');
  return execInContainer(containerId, ['cat', `${CONTAINER_WORKSPACE}/${safePath}`]);
}

/**
 * Write content to a file inside a running container's workspace directory.
 * Creates parent directories as needed. Uses printf to handle newlines correctly.
 */
export async function writeContainerFile(containerId: string, filePath: string, content: string): Promise<void> {
  const safePath = filePath.replace(/\.\./g, '').replace(/^\//, '');
  const dir = safePath.includes('/') ? safePath.substring(0, safePath.lastIndexOf('/')) : '';
  if (dir) {
    await execInContainer(containerId, ['mkdir', '-p', `${CONTAINER_WORKSPACE}/${dir}`]);
  }
  // Write via base64 to handle any content (binary-safe, preserves newlines)
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  await execInContainer(containerId, [
    'sh', '-c', `printf '%s' '${b64}' | base64 -d > ${CONTAINER_WORKSPACE}/${safePath}`
  ]);
}

/**
 * List files in the workspace directory of a running container.
 * Excludes node_modules, .git, and other noisy directories.
 */
export async function listContainerFiles(containerId: string): Promise<string[]> {
  const raw = await execInContainer(containerId, [
    'find', CONTAINER_WORKSPACE,
    '-not', '-path', '*/node_modules/*',
    '-not', '-path', '*/.git/*',
    '-not', '-path', '*/__pycache__/*',
    '-not', '-path', '*/.next/*',
    '-not', '-path', '*/dist/*',
    '-type', 'f'
  ]);
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(p => p.replace(`${CONTAINER_WORKSPACE}/`, ''))
    .sort();
}

/**
 * Execute a SQLite query inside a container and return JSON results.
 * The container runs PostgreSQL (assessmentdb) started by start.sh.
 * Falls back to SQLite (data.db) for legacy/local templates.
 */
export async function queryContainerDatabase(
  containerId: string,
  sql: string
): Promise<{ columns: string[]; rows: Record<string, any>[]; rowCount: number; error?: string }> {
  // Allow only single SELECT / PRAGMA/\d read statements.
  const stripped = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const allowedRead = /^(select|pragma\s+\w+|\\d[ts]?)/i;
  if (!allowedRead.test(stripped)) {
    return { columns: [], rows: [], rowCount: 0, error: 'Only SELECT statements are allowed in the DB explorer.' };
  }
  const withoutTrailingSemi = stripped.replace(/;+\s*$/, '');
  if (withoutTrailingSemi.includes(';')) {
    return { columns: [], rows: [], rowCount: 0, error: 'Multi-statement queries are not allowed.' };
  }

  // ── Try PostgreSQL first (assessmentdb is always running in the container) ──
  const escapedSqlPg = sql.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  try {
    const pgResult = await execInContainer(containerId, [
      'sh', '-c',
      `PGPASSWORD=postgres psql -U postgres -d assessmentdb -t -A -F '|||' -c '${escapedSqlPg}' 2>&1`
    ]);
    const pgTrimmed = pgResult.trim();
    // If psql returned an error, fall through to SQLite
    if (!pgTrimmed.toLowerCase().startsWith('error') && !pgTrimmed.includes('FATAL') && !pgTrimmed.includes('could not connect')) {
      // Parse pipe-delimited output
      const lines = pgTrimmed.split('\n').filter(l => l.trim() && !l.startsWith('('));
      if (lines.length === 0) return { columns: [], rows: [], rowCount: 0 };
      // First line is data — we need column names separately
      const colResult = await execInContainer(containerId, [
        'sh', '-c',
        `PGPASSWORD=postgres psql -U postgres -d assessmentdb -c '${escapedSqlPg}' 2>&1 | head -3`
      ]);
      const colLines = colResult.trim().split('\n');
      const headerLine = colLines[0] || '';
      const columns = headerLine.split('|').map(c => c.trim()).filter(Boolean);
      if (columns.length === 0) return { columns: [], rows: [], rowCount: 0 };
      const rows: Record<string, any>[] = lines.map(line => {
        const vals = line.split('|||');
        const row: Record<string, any> = {};
        columns.forEach((col, i) => { row[col] = vals[i]?.trim() ?? null; });
        return row;
      });
      return { columns, rows, rowCount: rows.length };
    }
  } catch {
    // Fall through to SQLite
  }

  // ── Fall back to SQLite (legacy templates that wrote data.db) ──
  const escapedSql = sql.replace(/'/g, "'\\''");
  const dbPaths = [
    `${CONTAINER_WORKSPACE}/data.db`,
    `${CONTAINER_WORKSPACE}/backend/data.db`,
    `${CONTAINER_WORKSPACE}/db/data.db`,
  ];

  let raw = '';
  let usedPath = '';
  for (const dbPath of dbPaths) {
    try {
      const result = await execInContainer(containerId, [
        'sh', '-c',
        `sqlite3 -json '${dbPath}' '${escapedSql}' 2>&1`
      ]);
      const trimmedResult = result.trim();
      if (trimmedResult.toLowerCase().startsWith('error:') ||
          trimmedResult.toLowerCase().startsWith('parse error:') ||
          trimmedResult.includes('no such table') ||
          trimmedResult.includes('unable to open database')) {
        continue;
      }
      raw = result;
      usedPath = dbPath;
      break;
    } catch {
      continue;
    }
  }

  if (!usedPath) {
    return { columns: [], rows: [], rowCount: 0, error: 'No database found yet. Start the backend (python backend/app.py) to initialise the PostgreSQL schema.' };
  }

  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    if (trimmed === '') return { columns: [], rows: [], rowCount: 0 };
    return { columns: [], rows: [], rowCount: 0, error: trimmed };
  }
  try {
    const parsed: Record<string, any>[] = JSON.parse(trimmed.startsWith('{') ? `[${trimmed}]` : trimmed);
    const columns = parsed.length > 0 ? Object.keys(parsed[0]) : [];
    return { columns, rows: parsed, rowCount: parsed.length };
  } catch {
    return { columns: [], rows: [], rowCount: 0, error: `Parse error: ${trimmed.slice(0, 200)}` };
  }
}

/**
 * Return schema info (tables + columns + row counts).
 * Tries PostgreSQL (assessmentdb) first, falls back to SQLite.
 */
export async function getContainerDatabaseSchema(containerId: string): Promise<{
  tables: Array<{ name: string; columns: Array<{ name: string; type: string; notNull: boolean; defaultValue: string | null; primaryKey: boolean }>; rowCount: number }>;
  engine?: 'postgresql' | 'sqlite';
}> {
  // ── Try PostgreSQL first ──────────────────────────────────────────────────────
  try {
    const tablesRaw = await execInContainer(containerId, [
      'sh', '-c',
      `PGPASSWORD=postgres psql -U postgres -d assessmentdb -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;" 2>&1`
    ]);
    const pgTrimmed = tablesRaw.trim();
    if (pgTrimmed && !pgTrimmed.toLowerCase().includes('error') && !pgTrimmed.includes('FATAL') && !pgTrimmed.includes('could not connect')) {
      const tableNames = pgTrimmed.split('\n').map(l => l.trim()).filter(Boolean);
      if (tableNames.length > 0) {
        const tables = await Promise.all(tableNames.map(async (tableName) => {
          // Column info from information_schema
          const colsRaw = await execInContainer(containerId, [
            'sh', '-c',
            `PGPASSWORD=postgres psql -U postgres -d assessmentdb -t -A -F '|' -c "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='${tableName}' ORDER BY ordinal_position;" 2>/dev/null`
          ]);
          const columns = colsRaw.trim().split('\n').filter(Boolean).map(line => {
            const [name, type, nullable, def] = line.split('|');
            const isPk = false; // simplified — PK detection via separate query is expensive
            return { name: name?.trim() || '', type: type?.trim() || 'text', notNull: nullable?.trim() === 'NO', defaultValue: def?.trim() || null, primaryKey: isPk };
          });
          // Row count
          let rowCount = 0;
          try {
            const countRaw = await execInContainer(containerId, [
              'sh', '-c',
              `PGPASSWORD=postgres psql -U postgres -d assessmentdb -t -A -c "SELECT COUNT(*) FROM \\"${tableName}\\";" 2>/dev/null`
            ]);
            rowCount = parseInt(countRaw.trim(), 10) || 0;
          } catch { /* ignore */ }
          return { name: tableName, columns, rowCount };
        }));
        return { tables, engine: 'postgresql' };
      }
    }
  } catch { /* fall through to SQLite */ }

  // ── Fall back to SQLite ───────────────────────────────────────────────────────
  const dbPaths = [
    `${CONTAINER_WORKSPACE}/data.db`,
    `${CONTAINER_WORKSPACE}/backend/data.db`,
    `${CONTAINER_WORKSPACE}/db/data.db`,
  ];

  let usedPath = '';
  for (const dbPath of dbPaths) {
    try {
      await execInContainer(containerId, ['test', '-f', dbPath]);
      usedPath = dbPath;
      break;
    } catch {
      continue;
    }
  }

  if (!usedPath) {
    return { tables: [], engine: 'postgresql' }; // PostgreSQL is present but empty (no tables yet)
  }

  const tablesRaw2 = await execInContainer(containerId, [
    'sh', '-c',
    `sqlite3 -json '${usedPath}' "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"`
  ]);

  let tableNames2: string[] = [];
  try {
    const parsed = JSON.parse(tablesRaw2.trim() || '[]');
    tableNames2 = parsed.map((r: any) => r.name);
  } catch {
    return { tables: [], engine: 'sqlite' };
  }

  const tables2 = await Promise.all(tableNames2.map(async (tableName) => {
    const colsRaw = await execInContainer(containerId, [
      'sh', '-c',
      `sqlite3 -json '${usedPath}' "PRAGMA table_info('${tableName}');" 2>/dev/null`
    ]);
    let columns: any[] = [];
    try {
      columns = JSON.parse(colsRaw.trim() || '[]').map((c: any) => ({
        name: c.name, type: c.type || 'TEXT', notNull: !!c.notnull,
        defaultValue: c.dflt_value ?? null, primaryKey: !!c.pk,
      }));
    } catch { /* ignore */ }
    let rowCount = 0;
    try {
      const countRaw = await execInContainer(containerId, [
        'sh', '-c', `sqlite3 '${usedPath}' "SELECT COUNT(*) FROM '${tableName}';" 2>/dev/null`
      ]);
      rowCount = parseInt(countRaw.trim(), 10) || 0;
    } catch { /* ignore */ }
    return { name: tableName, columns, rowCount };
  }));

  return { tables: tables2, engine: 'sqlite' };
}

/**
 * List all local containers
 */
export async function listLocalContainers(): Promise<Array<{ name: string; id: string; state: string; createdAt?: Date; codeServerPort?: number }>> {
  try {
    const containers = await docker.listContainers({ all: true });
    return containers
      .filter(c => c.Names?.some(name => name.includes('promora-')))
      .map(c => {
        // Find the host port mapped to container port 8080 (code-server)
        const codeServerPort = c.Ports?.find(p => p.PrivatePort === 8080)?.PublicPort;
        return {
          name: c.Names?.[0]?.replace('/', '') || '',
          id: c.Id || '',
          state: c.State || 'unknown',
          createdAt: c.Created ? new Date(c.Created * 1000) : undefined,
          codeServerPort,
        };
      });
  } catch (error: any) {
    logger.error('[Local Docker] Failed to list containers:', error);
    return [];
  }
}

/**
 * Cleanup old local containers
 */
export async function cleanupOldLocalContainers(maxAgeHours: number = 24): Promise<number> {
  try {
    const containers = await listLocalContainers();
    const now = new Date();
    const maxAge = maxAgeHours * 60 * 60 * 1000;

    let deletedCount = 0;
    for (const container of containers) {
      // Never delete running containers — they belong to active sessions
      if (container.state === 'running') continue;

      const shouldDelete =
        container.state === 'exited' ||
        container.state === 'stopped' ||
        (container.createdAt && (now.getTime() - container.createdAt.getTime()) > maxAge);

      if (shouldDelete) {
        try {
          await deleteLocalContainer(container.id);
          deletedCount++;
        } catch (error: any) {
          logger.error(`[Local Docker] Failed to delete container ${container.name}:`, error);
        }
      }
    }

    logger.log(`[Local Docker] Cleanup completed: ${deletedCount} containers deleted`);
    return deletedCount;
  } catch (error: any) {
    logger.error('[Local Docker] Cleanup failed:', error);
    return 0;
  }
}

/**
 * Inspect a running local Docker container and return its actual IDE + terminal URLs
 * by reading the live host-port bindings. Safe to call on reused containers whose
 * ports were dynamically allocated and not stored in the DB.
 */
export async function getLocalContainerUrls(
  containerId: string
): Promise<{ ideUrl: string; terminalUrl: string } | null> {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const ports = info.NetworkSettings?.Ports || {};
    const idePort = ports['8080/tcp']?.[0]?.HostPort;
    const terminalPort = ports['7681/tcp']?.[0]?.HostPort;
    if (!idePort) return null;
    const ideUrl = `http://${getLocalHost()}:${idePort}`;
    const terminalUrl = terminalPort ? `http://${getLocalHost()}:${terminalPort}` : ideUrl;
    return { ideUrl, terminalUrl };
  } catch {
    return null;
  }
}
