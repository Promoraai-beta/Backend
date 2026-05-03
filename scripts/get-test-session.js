const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getTestSession() {
  try {
    // Find any existing pending session
    const session = await prisma.session.findFirst({
      where: {
        status: 'pending'
      },
      include: {
        assessment: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (session) {
      console.log('\n✅ Found existing test session!');
      console.log('Session Code:', session.sessionCode);
      console.log('Access URL: http://localhost:3000/assessment/' + session.sessionCode);
      console.log('Status:', session.status);
      console.log('Candidate:', session.candidateName || session.candidateEmail);
      console.log('');
      await prisma.$disconnect();
      return session.sessionCode;
    }

    // If no session, check if there's an assessment we can use
    const assessment = await prisma.assessment.findFirst({
      where: {
        assessmentType: 'recruiter'
      }
    });

    if (!assessment) {
      console.log('\n❌ No pending sessions found and no assessments available.');
      console.log('Please create an assessment first via the dashboard.\n');
      await prisma.$disconnect();
      return null;
    }

    console.log('\n⚠️  No pending sessions found.');
    console.log('Found assessment ID:', assessment.id);
    console.log('Please create a session via the API or dashboard.\n');
    await prisma.$disconnect();
    return null;
  } catch (error) {
    console.error('Error:', error.message);
    await prisma.$disconnect();
    return null;
  }
}

getTestSession();
