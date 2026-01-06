/**
 * Backfill script: Emit journal.entry.created events for existing VendorCredit journal entries
 * 
 * This fixes the Balance Sheet not showing Inventory & AP amounts for vendor credits
 * that were posted before the bug fix.
 * 
 * Usage:
 *   npx tsx scripts/backfill_vendor_credit_events.ts
 * 
 * What it does:
 *   1. Finds all POSTED vendor credits with journalEntryId
 *   2. Checks if a journal.entry.created event already exists for that JE
 *   3. If not, creates the Event row in the outbox
 *   4. The publisher will pick up these events and the worker will update AccountBalance
 */

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Finding POSTED vendor credits with journal entries...');

  const vendorCredits = await prisma.vendorCredit.findMany({
    where: {
      status: 'POSTED',
      journalEntryId: { not: null },
    },
    select: {
      id: true,
      companyId: true,
      creditNumber: true,
      journalEntryId: true,
    },
  });

  console.log(`Found ${vendorCredits.length} posted vendor credit(s).`);

  let created = 0;
  let skipped = 0;

  for (const vc of vendorCredits) {
    if (!vc.journalEntryId) continue;

    // Check if an event already exists for this journal entry
    const existingEvent = await prisma.event.findFirst({
      where: {
        companyId: vc.companyId,
        eventType: 'journal.entry.created',
        aggregateType: 'JournalEntry',
        aggregateId: String(vc.journalEntryId),
      },
      select: { id: true },
    });

    if (existingEvent) {
      console.log(`  ✓ VC ${vc.creditNumber} (JE ${vc.journalEntryId}) - event already exists, skipping`);
      skipped++;
      continue;
    }

    // Create the event
    const eventId = randomUUID();
    const correlationId = randomUUID();
    const now = new Date();

    await prisma.event.create({
      data: {
        companyId: vc.companyId,
        eventId,
        eventType: 'journal.entry.created',
        type: 'JournalEntryCreated',
        schemaVersion: 'v1',
        occurredAt: now,
        source: 'backfill-vendor-credits',
        partitionKey: String(vc.companyId),
        correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String(vc.journalEntryId),
        payload: { journalEntryId: vc.journalEntryId, companyId: vc.companyId },
      },
    });

    console.log(`  ✅ VC ${vc.creditNumber} (JE ${vc.journalEntryId}) - created event ${eventId}`);
    created++;
  }

  // Also check for voided vendor credits with voidJournalEntryId
  console.log('\n🔍 Finding VOID vendor credits with reversal journal entries...');

  const voidedCredits = await prisma.vendorCredit.findMany({
    where: {
      status: 'VOID',
      voidJournalEntryId: { not: null },
    },
    select: {
      id: true,
      companyId: true,
      creditNumber: true,
      voidJournalEntryId: true,
    },
  });

  console.log(`Found ${voidedCredits.length} voided vendor credit(s).`);

  for (const vc of voidedCredits) {
    const voidJeId = (vc as any).voidJournalEntryId;
    if (!voidJeId) continue;

    // Check if an event already exists for this reversal journal entry
    const existingEvent = await prisma.event.findFirst({
      where: {
        companyId: vc.companyId,
        eventType: 'journal.entry.created',
        aggregateType: 'JournalEntry',
        aggregateId: String(voidJeId),
      },
      select: { id: true },
    });

    if (existingEvent) {
      console.log(`  ✓ VC ${vc.creditNumber} void (JE ${voidJeId}) - event already exists, skipping`);
      skipped++;
      continue;
    }

    // Create the event
    const eventId = randomUUID();
    const correlationId = randomUUID();
    const now = new Date();

    await prisma.event.create({
      data: {
        companyId: vc.companyId,
        eventId,
        eventType: 'journal.entry.created',
        type: 'JournalEntryCreated',
        schemaVersion: 'v1',
        occurredAt: now,
        source: 'backfill-vendor-credits',
        partitionKey: String(vc.companyId),
        correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String(voidJeId),
        payload: { journalEntryId: voidJeId, companyId: vc.companyId },
      },
    });

    console.log(`  ✅ VC ${vc.creditNumber} void (JE ${voidJeId}) - created event ${eventId}`);
    created++;
  }

  console.log(`\n✅ Done! Created ${created} event(s), skipped ${skipped} (already existed).`);
  console.log('   The publisher will pick these up and worker will update AccountBalance.');
  console.log('   Balance Sheet should reflect vendor credits after events are processed.');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

