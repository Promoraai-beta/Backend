/**
 * Script to diagnose and fix video chunk streamType mismatches
 * 
 * This script:
 * 1. Finds chunks where streamType doesn't match the URL path
 * 2. Optionally fixes them by updating streamType based on URL
 * 3. Reports statistics on chunk distribution
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function diagnoseAndFixChunks(sessionId?: string, fix: boolean = false) {
  try {
    console.log('🔍 Diagnosing video chunk streamType issues...\n');

    // Build where clause
    const where: any = {};
    if (sessionId) {
      where.sessionId = sessionId;
      console.log(`📋 Analyzing session: ${sessionId}\n`);
    } else {
      console.log('📋 Analyzing all sessions\n');
    }

    // Get all chunks
    const chunks = await prisma.videoChunk.findMany({
      where,
      orderBy: [
        { sessionId: 'asc' },
        { streamType: 'asc' },
        { chunkIndex: 'asc' }
      ]
    });

    console.log(`📊 Total chunks found: ${chunks.length}\n`);

    // Group by session
    const sessions = new Map<string, any[]>();
    chunks.forEach(chunk => {
      if (!sessions.has(chunk.sessionId)) {
        sessions.set(chunk.sessionId, []);
      }
      sessions.get(chunk.sessionId)!.push(chunk);
    });

    console.log(`📁 Sessions found: ${sessions.size}\n`);

    // Analyze each session
    let totalMismatches = 0;
    let totalFixed = 0;

    for (const [sessionId, sessionChunks] of sessions.entries()) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Session: ${sessionId}`);
      console.log(`${'='.repeat(80)}`);

      // Count by streamType
      const webcamChunks = sessionChunks.filter(c => c.streamType === 'webcam');
      const screenshareChunks = sessionChunks.filter(c => c.streamType === 'screenshare');
      const otherChunks = sessionChunks.filter(c => c.streamType !== 'webcam' && c.streamType !== 'screenshare');

      console.log(`\n📊 Chunk Distribution:`);
      console.log(`  - Webcam: ${webcamChunks.length} chunks`);
      console.log(`  - Screenshare: ${screenshareChunks.length} chunks`);
      if (otherChunks.length > 0) {
        console.log(`  - ⚠️  Other/Invalid: ${otherChunks.length} chunks`);
        otherChunks.forEach(c => {
          console.log(`    - ${c.streamType} chunk ${c.chunkIndex}`);
        });
      }

      // Check for URL mismatches
      console.log(`\n🔍 Checking URL/streamType mismatches:`);
      const mismatches: any[] = [];

      sessionChunks.forEach(chunk => {
        const urlContainsWebcam = chunk.url.includes('/webcam/');
        const urlContainsScreenshare = chunk.url.includes('/screenshare/');

        let expectedStreamType: string | null = null;
        if (urlContainsWebcam && !urlContainsScreenshare) {
          expectedStreamType = 'webcam';
        } else if (urlContainsScreenshare && !urlContainsWebcam) {
          expectedStreamType = 'screenshare';
        }

        if (expectedStreamType && chunk.streamType !== expectedStreamType) {
          mismatches.push({
            ...chunk,
            expectedStreamType
          });
          console.log(`  ❌ Mismatch: chunk ${chunk.chunkIndex}`);
          console.log(`     - Database streamType: "${chunk.streamType}"`);
          console.log(`     - URL indicates: "${expectedStreamType}"`);
          console.log(`     - URL: ${chunk.url.substring(chunk.url.length - 80)}`);
        }
      });

      if (mismatches.length === 0) {
        console.log(`  ✅ No mismatches found!`);
      } else {
        console.log(`\n  ⚠️  Found ${mismatches.length} mismatches`);
        totalMismatches += mismatches.length;

        if (fix) {
          console.log(`\n🔧 Fixing mismatches...`);
          for (const mismatch of mismatches) {
            try {
              await prisma.videoChunk.update({
                where: { id: mismatch.id },
                data: { streamType: mismatch.expectedStreamType }
              });
              console.log(`  ✅ Fixed chunk ${mismatch.chunkIndex}: ${mismatch.streamType} → ${mismatch.expectedStreamType}`);
              totalFixed++;
            } catch (error) {
              console.error(`  ❌ Failed to fix chunk ${mismatch.chunkIndex}:`, error);
            }
          }
        } else {
          console.log(`\n💡 Run with --fix flag to automatically fix these mismatches`);
        }
      }

      // Check for duplicate chunkIndexes within same streamType
      console.log(`\n🔍 Checking for duplicate chunkIndexes:`);
      const webcamIndexes = new Set<number>();
      const screenshareIndexes = new Set<number>();
      const webcamDuplicates: any[] = [];
      const screenshareDuplicates: any[] = [];

      webcamChunks.forEach(chunk => {
        if (webcamIndexes.has(chunk.chunkIndex)) {
          webcamDuplicates.push(chunk);
        } else {
          webcamIndexes.add(chunk.chunkIndex);
        }
      });

      screenshareChunks.forEach(chunk => {
        if (screenshareIndexes.has(chunk.chunkIndex)) {
          screenshareDuplicates.push(chunk);
        } else {
          screenshareIndexes.add(chunk.chunkIndex);
        }
      });

      if (webcamDuplicates.length > 0) {
        console.log(`  ⚠️  Found ${webcamDuplicates.length} duplicate webcam chunkIndexes`);
        webcamDuplicates.forEach(c => {
          console.log(`    - Chunk ${c.chunkIndex}: ${c.url.substring(c.url.length - 60)}`);
        });
      }

      if (screenshareDuplicates.length > 0) {
        console.log(`  ⚠️  Found ${screenshareDuplicates.length} duplicate screenshare chunkIndexes`);
        screenshareDuplicates.forEach(c => {
          console.log(`    - Chunk ${c.chunkIndex}: ${c.url.substring(c.url.length - 60)}`);
        });
      }

      if (webcamDuplicates.length === 0 && screenshareDuplicates.length === 0) {
        console.log(`  ✅ No duplicate chunkIndexes found`);
      }
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 Summary`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Total chunks analyzed: ${chunks.length}`);
    console.log(`Total sessions: ${sessions.size}`);
    console.log(`Total mismatches found: ${totalMismatches}`);
    if (fix) {
      console.log(`Total mismatches fixed: ${totalFixed}`);
    } else {
      console.log(`💡 Run with --fix to fix mismatches`);
    }

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const sessionId = args.find(arg => arg.startsWith('--session='))?.split('=')[1];
const fix = args.includes('--fix');

// Run the script
diagnoseAndFixChunks(sessionId, fix)
  .then(() => {
    console.log('\n✅ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });

