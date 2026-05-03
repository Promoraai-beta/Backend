/**
 * clear-cached-docs.js
 * Clears the cached Google Docs toolResource from recent sessions so they
 * get re-provisioned (with pre-fill) on the next "Open Google Doc" click.
 *
 * Usage:
 *   node scripts/clear-cached-docs.js          # clears ALL sessions with cached empty docs
 *   node scripts/clear-cached-docs.js SESSION_CODE   # clears one specific session
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function run() {
  const target = process.argv[2]; // optional session code

  const where = target
    ? { sessionCode: target }
    : { toolResources: { path: ['docs'], not: 'undefined' } };

  const sessions = await prisma.session.findMany({
    where: { toolResources: { not: null } },
    select: { id: true, sessionCode: true, toolResources: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: target ? 1 : 50,
    ...(target ? { where: { sessionCode: target } } : {}),
  });

  const withDocs = sessions.filter(s => s.toolResources && s.toolResources.docs);

  if (withDocs.length === 0) {
    console.log('No sessions found with cached docs toolResource.');
    return;
  }

  console.log(`Found ${withDocs.length} session(s) with cached docs:`);
  for (const s of withDocs) {
    const docUrl = s.toolResources.docs?.url || '?';
    console.log(`  ${s.sessionCode || s.id}  (created ${s.createdAt.toISOString().slice(0, 10)})  → ${docUrl.slice(0, 60)}...`);
  }

  const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => readline.question('\nClear cached docs from these sessions? (y/N) ', r));
  readline.close();

  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Aborted.');
    return;
  }

  for (const s of withDocs) {
    const current = s.toolResources || {};
    const { docs, ...rest } = current; // remove docs key
    await prisma.session.update({
      where: { id: s.id },
      data: { toolResources: rest },
    });
    console.log(`  ✓ Cleared docs from session ${s.sessionCode || s.id}`);
  }

  console.log('\nDone. These sessions will get fresh pre-filled Google Docs on next click.');
}

run().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
}).finally(() => prisma.$disconnect());
