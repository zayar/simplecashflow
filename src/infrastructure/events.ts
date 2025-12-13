import { prisma } from './db.js';

export async function markEventPublished(eventId: string) {
  try {
    await prisma.event.update({
      where: { eventId },
      data: {
        publishedAt: new Date(),
        nextPublishAttemptAt: null,
        lastPublishError: null,
      },
    });
  } catch (err) {
    // If this fails, the publisher will re-send later; consumers are idempotent.
    console.error('Failed to mark event as published', { eventId, err });
  }
}

