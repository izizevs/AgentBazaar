// GET /agents/:pubkey/reputation — reputation snapshot for an agent wallet

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { createDbClient } from '../db/client.js';
import { agentReputation } from '../db/schema.js';
import { validateParam } from '../middleware/validate.js';
import type { Bindings } from '../types.js';

const pubkeyParamSchema = z.object({
  pubkey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a valid base58 pubkey'),
});

export const agentsRouter = new Hono<{ Bindings: Bindings }>();

// GET /agents/:pubkey/reputation
agentsRouter.get('/:pubkey/reputation', validateParam(pubkeyParamSchema), async (c) => {
  const db = createDbClient(c.env.DATABASE_URL);
  const { pubkey } = c.req.valid('param');

  const [row] = await db
    .select()
    .from(agentReputation)
    .where(eq(agentReputation.wallet, pubkey))
    .limit(1);

  if (!row) {
    // Return a zero-state reputation for agents with no on-chain history yet.
    return c.json({
      data: {
        wallet: pubkey,
        jobsCompleted: '0',
        avgScore: 0,
        totalScore: '0',
        lastUpdated: null,
      },
    });
  }

  return c.json({
    data: {
      wallet: row.wallet,
      jobsCompleted: row.jobsCompleted?.toString() ?? '0',
      avgScore: row.avgScore,
      totalScore: row.totalScore?.toString() ?? '0',
      lastUpdated: row.lastUpdated,
    },
  });
});
