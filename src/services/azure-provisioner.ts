/**
 * Azure Container Instance Provisioner
 * Creates and manages Azure Container Instances for assessment sessions
 */

import { ContainerInstanceManagementClient } from '@azure/arm-containerinstance';
import { DefaultAzureCredential, ClientSecretCredential } from '@azure/identity';
import { logger } from '../lib/logger';
import { fileServerToken } from '../lib/container-token';

/** Use Service Principal (client ID + secret) if set; otherwise DefaultAzureCredential (e.g. az login). */
function getAzureCredential() {
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID;
  if (clientId && clientSecret && tenantId) {
    return new ClientSecretCredential(tenantId, clientId, clientSecret);
  }
  return new DefaultAzureCredential();
}

const SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID || '';
const RESOURCE_GROUP = process.env.AZURE_RESOURCE_GROUP || 'Promoraai';
const ACR_NAME = process.env.AZURE_ACR_NAME || 'promoraacr';
const ACR_IMAGE = `${ACR_NAME}.azurecr.io/promora-assessment:latest`;
const LOCATION = process.env.AZURE_LOCATION || 'eastus';
// Default: use public image so /test-assessment works without building/pushing to ACR.
// Set AZURE_USE_ACR_IMAGE=true (and AZURE_ACR_PASSWORD) to use your ACR image instead.
const USE_PUBLIC_IMAGE = process.env.AZURE_USE_ACR_IMAGE !== 'true';
const PUBLIC_IMAGE = 'mcr.microsoft.com/azuredocs/aci-helloworld'; // serves on port 80

export interface ContainerProvisionResult {
  containerId: string;
  containerGroupName: string;
  fqdn: string;
  codeServerUrl: string;
  status: 'provisioning' | 'running';
}

/**
 * Provision an Azure Container Instance for an assessment session
 */
export async function provisionAssessmentContainer(
  sessionId: string,
  templateFiles?: Record<string, string> | null
): Promise<ContainerProvisionResult> {
  if (!SUBSCRIPTION_ID) {
    throw new Error('AZURE_SUBSCRIPTION_ID environment variable is not set');
  }

  try {
    const credential = getAzureCredential();
    const client = new ContainerInstanceManagementClient(credential, SUBSCRIPTION_ID);

    // Generate unique container group name (Azure requires lowercase, alphanumeric, hyphens)
    const timestamp = Date.now();
    const shortSessionId = sessionId.replace(/-/g, '').slice(0, 8);
    const containerGroupName = `promora-${shortSessionId}-${timestamp}`;
    const dnsNameLabel = `promora-${shortSessionId}-${timestamp.toString(36)}`;

    const usePublic = USE_PUBLIC_IMAGE;
    const image = usePublic ? PUBLIC_IMAGE : ACR_IMAGE;
    const port = usePublic ? 80 : 8080;
    logger.log(`[Azure] Provisioning container for session ${sessionId}: ${containerGroupName} (image: ${image})`);

    const containerGroup: any = {
      location: LOCATION,
      containers: [
        {
          name: 'assessment',
          image,
          resources: {
            requests: {
              cpu: 1,
              memoryInGB: 1.5,
            },
          },
          // Expose port 8080 (code-server), 9090 (file-server for AI chat),
          // 5173 (Vite preview), 5000 (Flask backend), 5050 (pgweb DB UI)
          ports: [
            { port, protocol: 'TCP' as const },
            { port: 9090, protocol: 'TCP' as const },
            { port: 5173, protocol: 'TCP' as const },
            { port: 5000, protocol: 'TCP' as const },
            { port: 5050, protocol: 'TCP' as const },
          ],
          environmentVariables: (() => {
            const token = fileServerToken(sessionId);
            const envVars: any[] = [
              { name: 'SESSION_ID', value: sessionId },
              { name: 'FILE_SERVER_TOKEN', value: token },
            ];
            if (templateFiles && Object.keys(templateFiles).length > 0) {
              const encoded = Buffer.from(JSON.stringify({ files: templateFiles }), 'utf8').toString('base64');
              envVars.push({ name: 'TEMPLATE_FILES_B64', value: encoded });
              logger.log(`[Azure] Injecting ${Object.keys(templateFiles).length} template files via env var`);
            }
            return envVars;
          })(),
        },
      ],
      osType: 'Linux' as const,
      restartPolicy: 'Never' as const,
      ipAddress: {
        type: 'Public' as const,
        ports: [
          { port, protocol: 'TCP' as const },
          { port: 9090, protocol: 'TCP' as const },
          { port: 5173, protocol: 'TCP' as const },
          { port: 5000, protocol: 'TCP' as const },
          { port: 5050, protocol: 'TCP' as const },
        ],
        dnsNameLabel: dnsNameLabel,
      },
    };
    if (!usePublic && process.env.AZURE_ACR_PASSWORD) {
      containerGroup.imageRegistryCredentials = [
        {
          server: `${ACR_NAME}.azurecr.io`,
          username: ACR_NAME,
          password: process.env.AZURE_ACR_PASSWORD,
        },
      ];
    }

    const result = await client.containerGroups.beginCreateOrUpdateAndWait(
      RESOURCE_GROUP,
      containerGroupName,
      containerGroup
    );

    const fqdn = result.ipAddress?.fqdn || '';
    const codeServerUrl = fqdn ? (port === 80 ? `http://${fqdn}` : `http://${fqdn}:8080`) : '';
    const containerId = result.id || `subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ContainerInstance/containerGroups/${containerGroupName}`;
    const status = result.instanceView?.state === 'Running' ? 'running' : 'provisioning';

    logger.log(`[Azure] Container provisioned: ${containerGroupName}, FQDN: ${fqdn}, Status: ${status}`);

    return {
      containerId,
      containerGroupName,
      fqdn,
      codeServerUrl,
      status,
    };
  } catch (error: any) {
    logger.error('[Azure] Container provision failed:', error);
    throw new Error(`Failed to provision Azure container: ${error.message || error}`);
  }
}

/**
 * Delete an Azure Container Instance
 */
export async function deleteAssessmentContainer(containerId: string): Promise<void> {
  if (!SUBSCRIPTION_ID) {
    logger.warn('[Azure] AZURE_SUBSCRIPTION_ID not set, skipping container deletion');
    return;
  }

  try {
    const credential = getAzureCredential();
    const client = new ContainerInstanceManagementClient(credential, SUBSCRIPTION_ID);

    // Extract container group name from container ID
    // Format: .../containerGroups/{name}
    const containerGroupName = containerId.split('/').pop() || containerId;

    logger.log(`[Azure] Deleting container: ${containerGroupName}`);

    await client.containerGroups.beginDeleteAndWait(RESOURCE_GROUP, containerGroupName);

    logger.log(`[Azure] Container deleted: ${containerGroupName}`);
  } catch (error: any) {
    // Don't throw - cleanup failures shouldn't break the flow
    logger.error('[Azure] Container deletion failed:', error);
  }
}

/**
 * Get container status
 */
export async function getContainerStatus(containerId: string): Promise<'running' | 'stopped' | 'not-found'> {
  if (!SUBSCRIPTION_ID) {
    return 'not-found';
  }

  try {
    const credential = getAzureCredential();
    const client = new ContainerInstanceManagementClient(credential, SUBSCRIPTION_ID);

    const containerGroupName = containerId.split('/').pop() || containerId;
    const result = await client.containerGroups.get(RESOURCE_GROUP, containerGroupName);

    const state = result.instanceView?.state?.toLowerCase() || '';
    if (state === 'running') return 'running';
    if (state === 'stopped' || state === 'succeeded') return 'stopped';
    return 'stopped';
  } catch (error: any) {
    if (error.statusCode === 404) {
      return 'not-found';
    }
    logger.error('[Azure] Failed to get container status:', error);
    return 'not-found';
  }
}

/**
 * List all container groups in the resource group
 */
export async function listAllContainerGroups(): Promise<Array<{ name: string; id: string; state: string; createdAt?: Date }>> {
  if (!SUBSCRIPTION_ID) {
    logger.warn('[Azure] AZURE_SUBSCRIPTION_ID not set, cannot list containers');
    return [];
  }

  try {
    const credential = getAzureCredential();
    const client = new ContainerInstanceManagementClient(credential, SUBSCRIPTION_ID);

    const containers: Array<{ name: string; id: string; state: string; createdAt?: Date }> = [];
    const iterator = client.containerGroups.listByResourceGroup(RESOURCE_GROUP);

    for await (const containerGroup of iterator) {
      containers.push({
        name: containerGroup.name || '',
        id: containerGroup.id || '',
        state: containerGroup.instanceView?.state || 'unknown',
        createdAt: containerGroup.containers?.[0]?.instanceView?.currentState?.startTime
      });
    }

    logger.log(`[Azure] Found ${containers.length} container groups in resource group ${RESOURCE_GROUP}`);
    return containers;
  } catch (error: any) {
    logger.error('[Azure] Failed to list container groups:', error);
    return [];
  }
}

/**
 * Get current container quota usage
 */
export async function getContainerQuotaUsage(): Promise<{ usage: number; limit: number; available: number }> {
  if (!SUBSCRIPTION_ID) {
    return { usage: 0, limit: 0, available: 0 };
  }

  try {
    const containers = await listAllContainerGroups();
    // Count only running/active containers (not stopped/succeeded)
    const activeContainers = containers.filter(c => 
      c.state && !['stopped', 'succeeded', 'failed'].includes(c.state.toLowerCase())
    ).length;

    // Report active (running) containers against the quota — stopped/succeeded containers
    // do not consume compute resources and should not count against the limit.
    const limit = 100; // Default Azure limit
    const usage = activeContainers; // Only running containers consume quota
    const available = limit - usage;

    logger.log(`[Azure] Container quota: ${usage}/${limit} active (${containers.length} total incl. stopped)`);
    return { usage, limit, available };
  } catch (error: any) {
    logger.error('[Azure] Failed to get quota usage:', error);
    return { usage: 0, limit: 100, available: 100 };
  }
}

/**
 * Cleanup old/stale container groups
 * Deletes containers that are stopped or older than maxAgeHours
 */
export async function cleanupOldContainers(maxAgeHours: number = 24): Promise<number> {
  if (!SUBSCRIPTION_ID) {
    logger.warn('[Azure] AZURE_SUBSCRIPTION_ID not set, skipping cleanup');
    return 0;
  }

  try {
    const credential = getAzureCredential();
    const client = new ContainerInstanceManagementClient(credential, SUBSCRIPTION_ID);
    const containers = await listAllContainerGroups();
    const now = new Date();
    const maxAge = maxAgeHours * 60 * 60 * 1000; // Convert to milliseconds

    let deletedCount = 0;
    const containersToDelete: string[] = [];

    for (const container of containers) {
      const shouldDelete = 
        // Delete stopped/succeeded containers
        ['stopped', 'succeeded', 'failed'].includes(container.state?.toLowerCase() || '') ||
        // Delete containers older than maxAgeHours
        (container.createdAt && (now.getTime() - container.createdAt.getTime()) > maxAge);

      if (shouldDelete) {
        containersToDelete.push(container.name);
      }
    }

    logger.log(`[Azure] Found ${containersToDelete.length} containers to cleanup — deleting in parallel`);

    // Delete all stale containers simultaneously — same parallel pattern as the health monitor.
    // Total time = slowest single delete, not the sum of all deletes.
    const results = await Promise.allSettled(
      containersToDelete.map(async (containerName) => {
        await client.containerGroups.beginDeleteAndWait(RESOURCE_GROUP, containerName);
        logger.log(`[Azure] Deleted: ${containerName}`);
        return containerName;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        deletedCount++;
      } else {
        logger.error(`[Azure] Failed to delete container: ${result.reason}`);
      }
    }

    logger.log(`[Azure] Cleanup completed: ${deletedCount}/${containersToDelete.length} containers deleted`);
    return deletedCount;
  } catch (error: any) {
    logger.error('[Azure] Cleanup failed:', error);
    return 0;
  }
}

// Scheduled cleanup is now managed by container-cleanup.ts service.
// startContainerCleanup() is called from server.ts on boot.
