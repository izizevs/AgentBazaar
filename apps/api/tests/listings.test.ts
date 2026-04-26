// Unit tests for /listings routes — DB layer is mocked via vi.mock.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock drizzle client factory -----------------------------------------
vi.mock('../src/db/client.js', () => ({
  createDbClient: vi.fn(),
}));

import { createDbClient } from '../src/db/client.js';
import app from '../src/index.js';

const TEST_ENV = {
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  APP_VERSION: '0.1.0-test',
};

const SAMPLE_LISTING = {
  pubkey: 'ABC123DEF456ABC123DEF456ABC123DEF456ABC12',
  owner: 'OWN123DEF456ABC123DEF456ABC123DEF456OWN1',
  capabilityHash: 'abc123',
  satiAgentId: BigInt(1),
  priceUsdcBaseUnits: BigInt(1_000_000),
  pricingModel: 0,
  slaParams: {
    maxLatencyMs: 500,
    minUptimePct: 99,
    responseFormat: null,
    jsonSchemaUri: null,
    customParams: [],
  },
  metadataUri: 'ipfs://bafybeiabc123',
  isActive: true,
  jobsCompleted: BigInt(42),
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  capability: 'text-summarization',
  reputationScore: 85,
  endpoint: 'https://agent.example.com',
  metadata: { name: 'TestAgent' },
};

// Helper: build a mock drizzle db that handles the two-select pattern used in
// GET /listings (first: data rows with full chain; second: count row without orderBy/offset).
function mockDb(rows: unknown[], count: number) {
  // Data query chain: select().from().where().orderBy().limit().offset()
  const dataChain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn().mockResolvedValue(rows),
  };
  dataChain.from.mockReturnValue(dataChain);
  dataChain.where.mockReturnValue(dataChain);
  dataChain.orderBy.mockReturnValue(dataChain);
  dataChain.limit.mockReturnValue(dataChain);

  // Count query chain: select().from().where() → resolves immediately
  const countChain = {
    from: vi.fn(),
    where: vi.fn().mockResolvedValue([{ count }]),
  };
  countChain.from.mockReturnValue(countChain);

  let callIdx = 0;
  const db = {
    select: vi.fn().mockImplementation(() => {
      callIdx++;
      return callIdx === 1 ? dataChain : countChain;
    }),
  };
  return db;
}

// Single-row query helper: select().from().where().limit()
function mockDbSingle(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return { select: vi.fn().mockReturnValue(chain) };
}

describe('GET /listings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 — returns paginated listings', async () => {
    vi.mocked(createDbClient).mockReturnValue(mockDb([SAMPLE_LISTING], 1) as never);

    const res = await app.request('/listings', {}, TEST_ENV);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ pubkey: string; jobsCompleted: string }>;
      pagination: { total: number; limit: number; offset: number };
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]?.pubkey).toBe(SAMPLE_LISTING.pubkey);
    // BigInt serialized to string
    expect(body.data[0]?.jobsCompleted).toBe('42');
    expect(body.pagination.total).toBe(1);
    expect(body.pagination.limit).toBe(20);
    expect(body.pagination.offset).toBe(0);
  });

  it('200 — filters by capability param', async () => {
    vi.mocked(createDbClient).mockReturnValue(mockDb([SAMPLE_LISTING], 1) as never);
    const res = await app.request('/listings?capability=text-summarization', {}, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it('200 — respects custom limit and offset', async () => {
    vi.mocked(createDbClient).mockReturnValue(mockDb([], 0) as never);
    const res = await app.request('/listings?limit=5&offset=10', {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pagination: { limit: number; offset: number } };
    expect(body.pagination.limit).toBe(5);
    expect(body.pagination.offset).toBe(10);
  });

  it('400 — rejects limit > 100', async () => {
    const res = await app.request('/listings?limit=999', {}, TEST_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400 — rejects invalid sort value', async () => {
    const res = await app.request('/listings?sort=invalid', {}, TEST_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400 — rejects non-base58 owner param', async () => {
    const res = await app.request('/listings?owner=not-a-pubkey!', {}, TEST_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });
});

describe('GET /listings/:pubkey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 — returns a single listing', async () => {
    vi.mocked(createDbClient).mockReturnValue(mockDbSingle([SAMPLE_LISTING]) as never);

    const res = await app.request(`/listings/${SAMPLE_LISTING.pubkey}`, {}, TEST_ENV);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { pubkey: string } };
    expect(body.data.pubkey).toBe(SAMPLE_LISTING.pubkey);
  });

  it('404 — returns not_found for unknown pubkey', async () => {
    vi.mocked(createDbClient).mockReturnValue(mockDbSingle([]) as never);

    const res = await app.request(
      '/listings/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('400 — rejects invalid pubkey format', async () => {
    const res = await app.request('/listings/not-a-valid-pubkey!!', {}, TEST_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });
});
