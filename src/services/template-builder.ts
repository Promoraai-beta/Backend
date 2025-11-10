/**
 * Template Builder Service
 * 
 * Builds Docker images from template specifications
 * Creates pre-provisioned development environments
 */

import Docker from 'dockerode';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { existsSync } from 'fs';
// @ts-ignore - tar-fs doesn't have type definitions
import * as tar from 'tar-fs';
import { TemplateSpec } from '../mcp/types';

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
      console.log(`🐳 Using Docker socket: ${socketPath}`);
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

export interface TemplateBuildResult {
  templateId: string;
  dockerImage: string;
  status: 'building' | 'ready' | 'failed';
  buildTime: number;
  imageSize?: number;
  error?: string;
}

export interface ContainerInfo {
  containerId: string;
  status: string;
  port?: number;
  url?: string;
  ipAddress?: string;
}

export class TemplateBuilder {
  private buildDir: string;

  constructor() {
    this.buildDir = path.join(__dirname, '../../../templates');
  }

  /**
   * Generate Dockerfile from template specification
   */
  private async generateDockerfile(spec: TemplateSpec): Promise<string> {
    const { runtime, packageManager, dependencies, devDependencies, scripts } = spec;

    let dockerfile = `FROM ${runtime}\n`;
    dockerfile += `WORKDIR /workspace\n\n`;

    // Install dependencies based on package manager
    if (packageManager === 'npm' || packageManager === 'yarn') {
      dockerfile += `# Copy package files\n`;
      dockerfile += `COPY package*.json ./\n\n`;
      
      if (packageManager === 'npm') {
        dockerfile += `# Install dependencies\n`;
        dockerfile += `RUN npm install\n\n`;
      } else {
        dockerfile += `# Install yarn if needed\n`;
        dockerfile += `RUN npm install -g yarn\n`;
        dockerfile += `RUN yarn install\n\n`;
      }
    } else if (packageManager === 'pip') {
      dockerfile += `# Copy requirements file\n`;
      dockerfile += `COPY requirements.txt ./\n\n`;
      dockerfile += `# Install Python dependencies\n`;
      dockerfile += `RUN pip install --no-cache-dir -r requirements.txt\n\n`;
    }

    // Copy project files
    dockerfile += `# Copy project files\n`;
    dockerfile += `COPY . .\n\n`;

    // Expose port (default for web apps)
    if (packageManager === 'npm' || packageManager === 'yarn') {
      dockerfile += `EXPOSE 3000\n\n`;
    } else if (packageManager === 'pip') {
      dockerfile += `EXPOSE 8000\n\n`;
    }

    // Set default command
    if (scripts.dev) {
      dockerfile += `CMD ["${scripts.dev.split(' ')[0]}", "${scripts.dev.split(' ')[1] || ''}"]\n`;
    } else {
      dockerfile += `CMD ["sh"]\n`;
    }

    return dockerfile;
  }

  /**
   * Generate package.json from template spec (for Node.js projects)
   */
  private generatePackageJson(spec: TemplateSpec): string {
    return JSON.stringify({
      name: spec.name,
      version: '1.0.0',
      type: 'module',
      dependencies: spec.dependencies,
      devDependencies: spec.devDependencies || {},
      scripts: spec.scripts
    }, null, 2);
  }

  /**
   * Generate requirements.txt from template spec (for Python projects)
   */
  private generateRequirementsTxt(spec: TemplateSpec): string {
    const deps = Object.entries(spec.dependencies)
      .map(([name, version]) => {
        // Remove ^ or ~ from version
        const cleanVersion = version.replace(/^[\^~]/, '');
        return `${name}==${cleanVersion}`;
      })
      .join('\n');
    return deps;
  }

  /**
   * Create build directory and files
   */
  private async prepareBuildDirectory(
    templateId: string,
    spec: TemplateSpec
  ): Promise<string> {
    const buildPath = path.join(this.buildDir, templateId);

    // Create directory
    await fs.mkdir(buildPath, { recursive: true });

    // Generate Dockerfile
    const dockerfile = await this.generateDockerfile(spec);
    await fs.writeFile(path.join(buildPath, 'Dockerfile'), dockerfile);

    // Generate package.json or requirements.txt
    if (spec.packageManager === 'npm' || spec.packageManager === 'yarn') {
      const packageJson = this.generatePackageJson(spec);
      await fs.writeFile(path.join(buildPath, 'package.json'), packageJson);
    } else if (spec.packageManager === 'pip') {
      const requirements = this.generateRequirementsTxt(spec);
      await fs.writeFile(path.join(buildPath, 'requirements.txt'), requirements);
    }

    // Create file structure
    for (const [filePath, content] of Object.entries(spec.fileStructure)) {
      const fullPath = path.join(buildPath, filePath);
      const dir = path.dirname(fullPath);
      
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, content);
    }

    return buildPath;
  }

  /**
   * Build Docker image from template specification
   */
  async buildTemplate(
    templateId: string,
    spec: TemplateSpec
  ): Promise<TemplateBuildResult> {
    const startTime = Date.now();
    
    // Use registry if configured (production), otherwise local name (development)
    const registry = process.env.DOCKER_REGISTRY || ''; // e.g., "docker.io/yourorg" or "123456789.dkr.ecr.us-east-1.amazonaws.com"
    const imageTag = process.env.DOCKER_IMAGE_TAG || spec.name || templateId;
    const imageName = registry 
      ? `${registry}/promora/${imageTag}:latest`
      : `promora/${spec.name}:latest`;

    try {
      console.log(`🔨 Building template: ${templateId}`);
      
      // Prepare build directory
      const buildPath = await this.prepareBuildDirectory(templateId, spec);

      // Build Docker image using tar stream
      const tarStream = tar.pack(buildPath);
      
      const stream = await docker.buildImage(tarStream, {
        t: imageName,
      });

      // Wait for build to complete
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null, output: any) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      // Get image info
      const image = docker.getImage(imageName);
      const imageInfo = await image.inspect();
      const imageSize = imageInfo.Size || 0;

      const buildTime = Date.now() - startTime;

      console.log(`✅ Template built successfully: ${imageName} (${(buildTime / 1000).toFixed(2)}s)`);

      // Push to registry if configured (production)
      if (registry && process.env.NODE_ENV === 'production') {
        try {
          console.log(`📤 Pushing image to registry: ${imageName}`);
          await this.pushImageToRegistry(imageName);
          console.log(`✅ Image pushed to registry successfully`);
        } catch (pushError: any) {
          console.error(`⚠️ Failed to push image to registry: ${pushError.message}`);
          // Continue even if push fails - image is still available locally
        }
      }

      return {
        templateId,
        dockerImage: imageName,
        status: 'ready',
        buildTime,
        imageSize: Math.round(imageSize / 1024 / 1024) // Convert to MB
      };
    } catch (error: any) {
      console.error(`❌ Template build failed: ${error.message}`);
      
      return {
        templateId,
        dockerImage: imageName,
        status: 'failed',
        buildTime: Date.now() - startTime,
        error: error.message
      };
    }
  }

  /**
   * Push Docker image to registry (for production)
   */
  private async pushImageToRegistry(imageName: string): Promise<void> {
    try {
      const image = docker.getImage(imageName);
      
      // Create push stream
      const pushStream = await image.push({
        // Add authentication if needed
        // authconfig: {
        //   username: process.env.DOCKER_REGISTRY_USERNAME,
        //   password: process.env.DOCKER_REGISTRY_PASSWORD,
        //   serveraddress: process.env.DOCKER_REGISTRY
        // }
      });

      // Wait for push to complete
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(pushStream, (err: Error | null, output: any) => {
          if (err) {
            reject(err);
          } else {
            // Check for errors in output
            const outputStr = JSON.stringify(output);
            if (outputStr.includes('"error"') || outputStr.includes('"errorDetail"')) {
              reject(new Error(`Push failed: ${outputStr}`));
            } else {
              resolve();
            }
          }
        });
      });
    } catch (error: any) {
      throw new Error(`Failed to push image to registry: ${error.message}`);
    }
  }

  /**
   * Clone template container for a session
   */
  async cloneTemplate(
    dockerImage: string,
    sessionId: string
  ): Promise<ContainerInfo> {
    try {
      const containerName = `session-${sessionId}`;

      // Create container from template image
      const container = await docker.createContainer({
        Image: dockerImage,
        name: containerName,
        AttachStdout: true,
        AttachStderr: true,
        Env: [
          `SESSION_ID=${sessionId}`
        ],
        HostConfig: {
          Memory: 512 * 1024 * 1024, // 512MB
          CpuShares: 512, // 0.5 CPU
          PublishAllPorts: true
        },
        ExposedPorts: {
          '3000/tcp': {},
          '8000/tcp': {}
        }
      });

      // Start container
      await container.start();

      // Get container info
      const containerInfo = await container.inspect();
      
      // Extract port mapping
      const ports = containerInfo.NetworkSettings?.Ports || {};
      const port3000 = ports['3000/tcp']?.[0]?.HostPort;
      const port8000 = ports['8000/tcp']?.[0]?.HostPort;
      const mappedPort = port3000 || port8000 || '3000';

      return {
        containerId: container.id.substring(0, 12),
        status: containerInfo.State?.Status || 'running',
        port: parseInt(mappedPort),
        url: `http://localhost:${mappedPort}`,
        ipAddress: containerInfo.NetworkSettings?.IPAddress
      };
    } catch (error: any) {
      throw new Error(`Failed to clone template: ${error.message}`);
    }
  }

  /**
   * Stop and remove container
   */
  async stopContainer(containerId: string): Promise<void> {
    try {
      const containers = await docker.listContainers({ all: true });
      const containerInfo = containers.find(
        (c: any) => c.Id.startsWith(containerId) || c.Names?.includes(`/${containerId}`)
      );

      if (containerInfo) {
        const container = docker.getContainer(containerInfo.Id);
        
        // Stop if running
        if (containerInfo.State === 'running') {
          await container.stop();
        }
        
        // Remove
        await container.remove();
      }
    } catch (error: any) {
      console.error(`Failed to stop container ${containerId}: ${error.message}`);
    }
  }

  /**
   * Test template by running a container
   */
  async testTemplate(dockerImage: string): Promise<boolean> {
    try {
      const testContainer = await docker.createContainer({
        Image: dockerImage,
        name: `test-${Date.now()}`,
        Cmd: ['sh', '-c', 'echo "Template test successful"'],
      });

      await testContainer.start();
      await testContainer.wait();
      await testContainer.remove();

      return true;
    } catch (error: any) {
      console.error(`Template test failed: ${error.message}`);
      return false;
    }
  }
}

export const templateBuilder = new TemplateBuilder();

