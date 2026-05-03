const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixSessionExpiry(sessionCode) {
  try {
    // First check the current session
    const session = await prisma.session.findUnique({
      where: { sessionCode: sessionCode.toUpperCase() }
    });
    
    if (!session) {
      console.log('\n❌ Session not found:', sessionCode);
      await prisma.$disconnect();
      return;
    }
    
    console.log('\n📋 Current Session Info:');
    console.log('Code:', session.sessionCode);
    console.log('Status:', session.status);
    console.log('Current Expiry:', session.expiresAt);
    
    const now = new Date();
    const expires = session.expiresAt ? new Date(session.expiresAt) : null;
    
    if (expires && now > expires) {
      console.log('⚠️  Session has expired!');
      
      // Update session to have a future expiry date (24 hours from now)
      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 24);
      
      const updated = await prisma.session.update({
        where: { sessionCode: sessionCode.toUpperCase() },
        data: {
          expiresAt: futureDate,
          status: session.status === 'ended' || session.status === 'submitted' ? 'pending' : session.status
        }
      });
      
      console.log('\n✅ Session updated!');
      console.log('New Expiry:', updated.expiresAt.toISOString());
      console.log('Status:', updated.status);
      console.log('\n🌐 Access URL: http://localhost:3000/assessment/' + updated.sessionCode + '\n');
    } else {
      console.log('\n✅ Session is still valid!');
      console.log('Expires at:', expires.toISOString());
      if (expires) {
        const remaining = Math.round((expires - now) / 1000 / 60);
        console.log('Time remaining:', remaining, 'minutes');
      }
      console.log('\n🌐 Access URL: http://localhost:3000/assessment/' + session.sessionCode + '\n');
    }
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

const sessionCode = process.argv[2] || 'EC43DEB7';
fixSessionExpiry(sessionCode);
