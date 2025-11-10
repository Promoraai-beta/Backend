/**
 * Container Manager Service
 * 
 * Manages Docker containers for candidate sessions
 * Maps sessions to containers and handles lifecycle
 */

import { templateBuilder, ContainerInfo } from './template-builder';
import { logger } from '../lib/logger';

export interface SessionContainer {
  sessionId: string;
  containerId: string;
  templateId: string;
  status: 'creating' | 'running' | 'stopped' | 'removed';
  createdAt: Date;
  containerInfo?: ContainerInfo;
}

export class ContainerManager {
  private sessionContainers: Map<string, SessionContainer> = new Map();

  /**
   * Create container for session from template
   */
  async createSessionContainer(
    sessionId: string,
    dockerImage: string,
    templateId: string
  ): Promise<ContainerInfo> {
    try {
      logger.log(`🚀 Creating container for session: ${sessionId}`);

      // Record that we're creating
      this.sessionContainers.set(sessionId, {
        sessionId,
        containerId: '',
        templateId,
        status: 'creating',
        createdAt: new Date()
      });

      // Clone template container
      const containerInfo = await templateBuilder.cloneTemplate(dockerImage, sessionId);

      // Update record
      const sessionContainer: SessionContainer = {
        sessionId,
        containerId: containerInfo.containerId,
        templateId,
        status: 'running',
        createdAt: new Date(),
        containerInfo
      };

      this.sessionContainers.set(sessionId, sessionContainer);

      logger.log(`✅ Container created: ${containerInfo.containerId} for session ${sessionId}`);
      
      return containerInfo;
    } catch (error: any) {
      logger.error(`❌ Failed to create container: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get container info for session
   */
  getSessionContainer(sessionId: string): SessionContainer | undefined {
    return this.sessionContainers.get(sessionId);
  }

  /**
   * Stop container for session
   */
  async stopSessionContainer(sessionId: string): Promise<void> {
    const sessionContainer = this.sessionContainers.get(sessionId);
    
    if (sessionContainer && sessionContainer.containerId) {
      await templateBuilder.stopContainer(sessionContainer.containerId);
      
      // Update status
      sessionContainer.status = 'stopped';
      this.sessionContainers.set(sessionId, sessionContainer);
    }
  }

  /**
   * Remove container for session
   */
  async removeSessionContainer(sessionId: string): Promise<void> {
    const sessionContainer = this.sessionContainers.get(sessionId);
    
    if (sessionContainer && sessionContainer.containerId) {
      await templateBuilder.stopContainer(sessionContainer.containerId);
      
      // Remove from map
      this.sessionContainers.delete(sessionId);
    }
  }

  /**
   * Cleanup old containers (called periodically)
   */
  async cleanupExpiredContainers(maxAgeMinutes: number = 120): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [sessionId, container] of this.sessionContainers.entries()) {
      const age = now - container.createdAt.getTime();
      const ageMinutes = age / (1000 * 60);

      if (ageMinutes > maxAgeMinutes) {
        expired.push(sessionId);
      }
    }

    for (const sessionId of expired) {
      logger.log(`🧹 Cleaning up expired container for session: ${sessionId}`);
      await this.removeSessionContainer(sessionId);
    }

    if (expired.length > 0) {
      logger.log(`✅ Cleaned up ${expired.length} expired containers`);
    }
  }

  /**
   * Get all active containers
   */
  getAllContainers(): SessionContainer[] {
    return Array.from(this.sessionContainers.values());
  }
}

export const containerManager = new ContainerManager();

// Run cleanup every hour
setInterval(() => {
  containerManager.cleanupExpiredContainers().catch((error) => logger.error('Cleanup error:', error));
}, 60 * 60 * 1000);

