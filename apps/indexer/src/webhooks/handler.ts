import type { Context } from 'hono';
import { getSql } from '../db/client.js';
import { decodeRegistryEvent } from '../events/decoder.js';
import { onListingCreated } from '../events/on-listing-created.js';
import { onListingUpdated } from '../events/on-listing-updated.js';
import { logger } from '../logger.js';
import { verifyHeliusAuth } from './auth.js';
import { HeliusWebhookPayloadSchema } from './types.js';

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

  // Atomic replay dedup: INSERT all signatures, RETURNING only newly-inserted
  // ones. ON CONFLICT serializes concurrent deliveries at the DB row lock;
  // RETURNING gives exactly the new signatures. One round-trip, no TOCTOU race.
  // (security-auditor PR #35 M1 fix — carried from feature/backend-webhook-auth)
  let newEvents = events;
  if (process.env.DATABASE_URL) {
    const sql = getSql();
    const rows = events.map((e) => ({ signature: e.signature }));
    const inserted = await sql<{ signature: string }[]>`
      INSERT INTO processed_signatures ${sql(rows)}
      ON CONFLICT (signature) DO NOTHING
      RETURNING signature
    `;
    const newSigSet = new Set(inserted.map((r) => r.signature));
    newEvents = events.filter((e) => newSigSet.has(e.signature));
  }

  let relevant = 0;

  for (const tx of newEvents) {
    const isRegistryTx = tx.instructions.some((ix) => ix.programId === BAZAAR_REGISTRY_PROGRAM_ID);
    if (!isRegistryTx) continue;

    relevant++;

    // Decode Anchor events from inner instructions (emit_cpi! self-CPIs).
    for (const ix of tx.instructions) {
      if (ix.programId !== BAZAAR_REGISTRY_PROGRAM_ID) continue;
      for (const inner of ix.innerInstructions) {
        if (inner.programId !== BAZAAR_REGISTRY_PROGRAM_ID) continue;
        const event = decodeRegistryEvent(inner.data);
        if (!event) continue;

        try {
          if (event.name === 'ServiceListingCreated') {
            await onListingCreated(tx.signature, event.data);
          } else if (event.name === 'ServiceListingUpdated') {
            await onListingUpdated(tx.signature, event.data);
          }
        } catch (err) {
          logger.error(
            { err, txSignature: tx.signature, event: event.name },
            'event handler failed',
          );
        }
      }
    }
  }

  const skipped = events.length - newEvents.length;
  logger.debug({ total: events.length, relevant, skipped }, 'helius webhook processed');
  return c.json({ ok: true, processed: newEvents.length, relevant, skipped });
}
