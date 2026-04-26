// Unit tests for GET /escrows/:pubkey
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/client.js', () => ({
  createDbClient: vi.fn(),
}));

import { createDbClient } from '../src/db/client.js';
import app from '../src/index.js';

const TEST_ENV = {
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  APP_VERSION: '0.1.0-test',
};

const SAMPLE_ESCROW = {
  pubkey: 'ESC123DEF456ABC123DEF456ABC123DEF456ESC1',
  buyer: 'BUY123DEF456ABC123DEF456ABC123DEF456BUY1',
  seller: 'SEL123DEF456ABC123DEF456ABC123DEF456SEL1',
  listing: 'LST123DEF456ABC123DEF456ABC123DEF456LST1',
  vault: 'VLT123DEF456ABC123DEF456ABC123DEF456VLT1',
  amountUsdc: BigInt(5_000_000),
  slaParams: {},
  state: 'created' as const,
  resultUri: null,
  resultHash: null,
  deadline: new Date('2024-12-31T00:00:00Z'),
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

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

describe('GET /escrows/:pubkey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 — returns escrow detail', async () => {
    vi.mocked(createDbClient).mockReturnValue(mockDbSingle([SAMPLE_ESCROW]) as never);

    const res = await app.request(`/escrows/${SAMPLE_ESCROW.pubkey}`, {}, TEST_ENV);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { pubkey: string; state: string; amountUsdc: string };
    };
    expect(body.data.pubkey).toBe(SAMPLE_ESCROW.pubkey);
    expect(body.data.state).toBe('created');
    expect(body.data.amountUsdc).toBe('5000000');
  });

  it('404 — not_found for unknown pubkey', async () => {
    vi.mocked(createDbClient).mockReturnValue(mockDbSingle([]) as never);

    const res = await app.request(
      '/escrows/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('400 — rejects invalid pubkey', async () => {
    const res = await app.request('/escrows/bad!pubkey', {}, TEST_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });
});
