import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log('Getting latest event for companyId=1...\n');

    const event = await prisma.event.findFirst({
      where: {
        companyId: 1,
        eventType: 'journal.entry.created'
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (event) {
      console.log('✅ Found event:');
      console.log(`Event ID: ${event.eventId}`);
      console.log(`Journal Entry ID: ${event.payload.journalEntryId}`);
      console.log(`Payload:`, JSON.stringify(event.payload, null, 2));
      console.log('\nUse this command to simulate duplicate:');
      console.log(`python3 simulate_duplicate.py ${event.eventId} 1 ${event.payload.journalEntryId}`);
    } else {
      console.log('❌ No events found');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
