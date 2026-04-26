// GET /escrows/:pubkey — single escrow detail

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { createDbClient } from '../db/client.js';
import { escrows } from '../db/schema.js';
import { validateParam } from '../middleware/validate.js';
import type { Bindings } from '../types.js';

const pubkeyParamSchema = z.object({
  pubkey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a valid base58 pubkey'),
});

function serializeEscrow(row: typeof escrows.$inferSelect) {
  return {
    pubkey: row.pubkey,
    buyer: row.buyer,
    seller: row.seller,
    listing: row.listing,
    vault: row.vault,
    amountUsdc: row.amountUsdc?.toString() ?? null,
    slaParams: row.slaParams,
    state: row.state,
    resultUri: row.resultUri,
    deadline: row.deadline,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const escrowsRouter = new Hono<{ Bindings: Bindings }>();

// GET /escrows/:pubkey
escrowsRouter.get('/:pubkey', validateParam(pubkeyParamSchema), async (c) => {
  const db = createDbClient(c.env.DATABASE_URL);
  const { pubkey } = c.req.valid('param');

  const [row] = await db.select().from(escrows).where(eq(escrows.pubkey, pubkey)).limit(1);

  if (!row) {
    return c.json({ error: 'not_found', message: `Escrow ${pubkey} not found` }, 404);
  }

  return c.json({ data: serializeEscrow(row) });
});
