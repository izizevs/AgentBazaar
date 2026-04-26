// Unit tests for GET /agents/:pubkey/reputation
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

const SAMPLE_REPUTATION = {
  wallet: 'AGT123DEF456ABC123DEF456ABC123DEF456AGT1',
  jobsCompleted: BigInt(100),
  avgScore: 88,
  totalScore: BigInt(8800),
  lastUpdated: new Date('2024-06-01T00:00:00Z'),
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

describe('GET /agents/:pubkey/reputation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 — returns reputation snapshot', async () => {
    vi.mocked(createDbClient).mockReturnValue(mockDbSingle([SAMPLE_REPUTATION]) as never);

    const res = await app.request(`/agents/${SAMPLE_REPUTATION.wallet}/reputation`, {}, TEST_ENV);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { wallet: string; jobsCompleted: string; avgScore: number };
    };
    expect(body.data.wallet).toBe(SAMPLE_REPUTATION.wallet);
    expect(body.data.jobsCompleted).toBe('100');
    expect(body.data.avgScore).toBe(88);
  });

  it('200 — returns zero-state for unknown agent', async () => {
    vi.mocked(createDbClient).mockReturnValue(mockDbSingle([]) as never);

    const res = await app.request(
      '/agents/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/reputation',
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { jobsCompleted: string; avgScore: number } };
    expect(body.data.jobsCompleted).toBe('0');
    expect(body.data.avgScore).toBe(0);
  });

  it('400 — rejects invalid pubkey', async () => {
    const res = await app.request('/agents/bad!pubkey/reputation', {}, TEST_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });
});
