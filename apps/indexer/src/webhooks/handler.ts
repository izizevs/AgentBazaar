import type { Context } from 'hono';
import { getSql } from '../db/client.js';
import { logger } from '../logger.js';
import { verifyHeliusAuth } from './auth.js';
import { HeliusWebhookPayloadSchema } from './types.js';

// bazaar-registry program ID — devnet deployment (Task #4).
const BAZAAR_REGISTRY_PROGRAM_ID = 'GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd';

export async function handleHeliusWebhook(c: Context): Promise<Response> {
  if (!verifyHeliusAuth(c)) {
    logger.warn('helius webhook rejected: invalid or missing Authorization');
    return c.json({ error: 'unauthorized' }, 401);
  }

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
  if (events.length === 0) {
    return c.json({ ok: true, processed: 0, relevant: 0, skipped: 0 });
  }

  // Replay dedup: filter out already-processed Solana tx signatures.
  // Only runs when DATABASE_URL is configured; skipped in CI/test environments
  // without a DB. All writes use ON CONFLICT DO NOTHING for idempotency.
  let newEvents = events;
  if (process.env['DATABASE_URL']) {
    const sql = getSql();
    const seenSet = new Set<string>();
    for (const event of events) {
      const rows = await sql<{ signature: string }[]>`
        SELECT signature FROM processed_signatures WHERE signature = ${event.signature}
      `;
      if (rows.length > 0) seenSet.add(event.signature);
    }
    newEvents = events.filter((e) => !seenSet.has(e.signature));
  }

  let relevant = 0;
  for (const event of newEvents) {
    const isRegistryEvent = event.instructions.some(
      (ix) => ix.programId === BAZAAR_REGISTRY_PROGRAM_ID,
    );
    if (!isRegistryEvent) continue;

    relevant++;
    // Task #13: route to ServiceListingCreated / ServiceListingUpdated handlers.
    logger.info(
      { signature: event.signature, slot: event.slot },
      'bazaar-registry event received — handler stub',
    );
  }

  // Record processed signatures so replayed deliveries are deduplicated.
  if (newEvents.length > 0 && process.env['DATABASE_URL']) {
    const sql = getSql();
    for (const event of newEvents) {
      await sql`
        INSERT INTO processed_signatures (signature) VALUES (${event.signature})
        ON CONFLICT (signature) DO NOTHING
      `;
    }
  }

  const skipped = events.length - newEvents.length;
  logger.debug({ total: events.length, relevant, skipped }, 'helius webhook processed');
  return c.json({ ok: true, processed: newEvents.length, relevant, skipped });
}
