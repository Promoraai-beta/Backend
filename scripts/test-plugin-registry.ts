/**
 * Quick test for plugin registry (Figma only).
 * Run: npx ts-node scripts/test-plugin-registry.ts
 */
import { getPlugin, listPlugins } from '../src/services/plugin-registry';

console.log('Plugins:', listPlugins());
const figma = getPlugin('figma');
console.log('Figma plugin:', figma ? figma.name : 'missing');
if (figma) {
  console.log('  id:', figma.id);
  console.log('  manifest.credentials_required:', figma.manifest.credentials_required);
}
