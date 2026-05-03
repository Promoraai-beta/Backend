/**
 * Test script to verify template injection in containers
 * Run: npx ts-node backend/test-template-injection.ts
 */

import { provisionLocalContainer, deleteLocalContainer } from './src/services/local-docker-provisioner';
import { readFileSync } from 'fs';
import { join } from 'path';

async function testTemplateInjection() {
  console.log('🧪 Testing template injection in container...\n');

  // Load template file
  const templatePath = join(process.cwd(), 'container', 'template.json');
  const templateContent = JSON.parse(readFileSync(templatePath, 'utf-8'));
  const templateFiles = templateContent.files || {};

  console.log(`📦 Loaded template with ${Object.keys(templateFiles).length} files`);
  console.log(`   Files: ${Object.keys(templateFiles).slice(0, 5).join(', ')}...\n`);

  const sessionId = `test-${Date.now()}`;
  console.log(`🚀 Provisioning container for session: ${sessionId}`);

  try {
    // Provision container with template files
    const result = await provisionLocalContainer(sessionId, templateFiles);

    console.log(`✅ Container provisioned:`);
    console.log(`   Container ID: ${result.containerId}`);
    console.log(`   IDE URL: ${result.codeServerUrl}`);
    console.log(`   Terminal URL: ${result.terminalUrl}`);
    console.log(`\n📝 Open ${result.codeServerUrl} in your browser to verify template files are injected`);
    console.log(`\n⏳ Waiting 30 seconds for container to initialize...`);

    // Wait for container to initialize
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Check if template files exist in container
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    console.log(`\n🔍 Checking if template files were injected...`);

    const checkFiles = await execAsync(
      `docker exec ${result.containerId} ls -la /home/candidate/workspace/ | head -20`
    );
    console.log(checkFiles.stdout);

    const checkSrc = await execAsync(
      `docker exec ${result.containerId} find /home/candidate/workspace/src -type f | head -10`
    );
    console.log('📁 Source files:');
    console.log(checkSrc.stdout);

    console.log(`\n✅ Test complete! Container is running at ${result.codeServerUrl}`);
    console.log(`\n💡 To clean up, run:`);
    console.log(`   docker stop ${result.containerId}`);
    console.log(`   docker rm ${result.containerId}`);

  } catch (error: any) {
    console.error(`❌ Test failed:`, error.message);
    process.exit(1);
  }
}

testTemplateInjection().catch(console.error);
