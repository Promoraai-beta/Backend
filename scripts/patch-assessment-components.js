/**
 * One-off patch: backfill 'template.components' on an assessment.
 * Run from the backend directory:
 *   node scripts/patch-assessment-components.js <assessmentId> <component1,component2,...>
 *
 * Example:
 *   node scripts/patch-assessment-components.js d77813f3-7050-42f0-8b41-89d0b6ccf6f7 ide_project,database,docs
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const [,, assessmentId, componentsArg] = process.argv;

  if (!assessmentId || !componentsArg) {
    console.error('Usage: node scripts/patch-assessment-components.js <assessmentId> <component1,component2,...>');
    process.exit(1);
  }

  const components = componentsArg.split(',').map(c => c.trim()).filter(Boolean);

  const assessment = await prisma.assessment.findUnique({
    where: { id: assessmentId },
    select: { id: true, template: true, templateId: true },
  });

  if (!assessment) {
    console.error(`Assessment ${assessmentId} not found`);
    process.exit(1);
  }

  console.log('Current template:', assessment.template);
  console.log('templateId:', assessment.templateId);
  console.log('Setting components to:', components);

  const existing = (assessment.template && typeof assessment.template === 'object' && !Array.isArray(assessment.template))
    ? assessment.template
    : {};

  await prisma.assessment.update({
    where: { id: assessmentId },
    data: { template: { ...existing, components } },
  });

  console.log('✅ Patched successfully');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
