import type { Context } from 'hono';
import { logger } from '../logger.js';
import { HeliusWebhookPayloadSchema } from './types.js';

// bazaar-registry program ID — devnet deployment (Task #4).
const BAZAAR_REGISTRY_PROGRAM_ID = 'GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd';

export async function handleHeliusWebhook(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const result = HeliusWebhookPayloadSchema.safeParse(body);
  if (!result.success) {
    logger.warn({ issues: result.error.issues }, 'helius webhook payload failed validation');
    return c.json({ error: 'invalid payload', details: result.error.issues }, 400);
  }

  const events = result.data;
  let relevant = 0;

  for (const event of events) {
    const isRegistryEvent = event.instructions.some(
      (ix) => ix.programId === BAZAAR_REGISTRY_PROGRAM_ID,
    );
    if (!isRegistryEvent) continue;

    relevant++;
    // Task #15: route to ServiceListingCreated / ServiceListingUpdated handlers.
    logger.info(
      { signature: event.signature, slot: event.slot },
      'bazaar-registry event received — handler stub',
    );
  }

  logger.debug({ total: events.length, relevant }, 'helius webhook processed');
  return c.json({ ok: true, processed: events.length, relevant });
}
