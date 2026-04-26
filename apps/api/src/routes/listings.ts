// GET /listings       — paginated list with optional filters
// GET /listings/:pubkey — single listing detail

import { and, asc, desc, eq, ilike, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { createDbClient } from '../db/client.js';
import { serviceListings } from '../db/schema.js';
import { validateParam, validateQuery } from '../middleware/validate.js';
import type { Bindings } from '../types.js';

// ---- Query schemas -------------------------------------------------------

const listingsQuerySchema = z.object({
  capability: z.string().min(1).max(256).optional(),
  owner: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a valid base58 pubkey')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['reputation', 'price', 'completedJobs']).default('reputation'),
  order: z.enum(['asc', 'desc']).default('desc'),
  isActive: z.coerce.boolean().default(true),
});

const pubkeyParamSchema = z.object({
  pubkey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a valid base58 pubkey'),
});

// ---- Serialization -------------------------------------------------------

// BigInt values must be serialized to strings for JSON transport.
function serializeListing(row: typeof serviceListings.$inferSelect) {
  return {
    pubkey: row.pubkey,
    owner: row.owner,
    satiAgentId: row.satiAgentId?.toString() ?? null,
    priceUsdcBaseUnits: row.priceUsdcBaseUnits?.toString() ?? null,
    pricingModel: row.pricingModel,
    slaParams: row.slaParams,
    metadataUri: row.metadataUri,
    isActive: row.isActive,
    jobsCompleted: row.jobsCompleted?.toString() ?? null,
    capability: row.capability,
    reputationScore: row.reputationScore,
    endpoint: row.endpoint,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---- Router ---------------------------------------------------------------

export const listingsRouter = new Hono<{ Bindings: Bindings }>();

// GET /listings
listingsRouter.get('/', validateQuery(listingsQuerySchema), async (c) => {
  const db = createDbClient(c.env.DATABASE_URL);
  const { capability, owner, limit, offset, sort, order, isActive } = c.req.valid('query');

  const conditions = [eq(serviceListings.isActive, isActive)];

  if (capability) {
    conditions.push(ilike(serviceListings.capability, `%${capability}%`));
  }
  if (owner) {
    conditions.push(eq(serviceListings.owner, owner));
  }

  // Build ORDER BY expression
  const sortCol =
    sort === 'price'
      ? serviceListings.priceUsdcBaseUnits
      : sort === 'completedJobs'
        ? serviceListings.jobsCompleted
        : serviceListings.reputationScore;

  const orderExpr = order === 'asc' ? asc(sortCol) : desc(sortCol);

  const rows = await db
    .select()
    .from(serviceListings)
    .where(and(...conditions))
    .orderBy(orderExpr)
    .limit(limit)
    .offset(offset);

  // Total count for pagination metadata
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(serviceListings)
    .where(and(...conditions));

  return c.json({
    data: rows.map(serializeListing),
    pagination: {
      total: countRow?.count ?? 0,
      limit,
      offset,
    },
  });
});

// GET /listings/:pubkey
listingsRouter.get('/:pubkey', validateParam(pubkeyParamSchema), async (c) => {
  const db = createDbClient(c.env.DATABASE_URL);
  const { pubkey } = c.req.valid('param');

  const [row] = await db
    .select()
    .from(serviceListings)
    .where(eq(serviceListings.pubkey, pubkey))
    .limit(1);

  if (!row) {
    return c.json({ error: 'not_found', message: `Listing ${pubkey} not found` }, 404);
  }

  return c.json({ data: serializeListing(row) });
});
