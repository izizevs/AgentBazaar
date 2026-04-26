// Unit tests for individual MCP tool implementations.
// ApiClient is replaced with a hand-rolled mock so tests are fully offline.
import { describe, expect, it, vi } from 'vitest';
import type {
  ApiClient,
  ListingDetail,
  ListingsResponse,
  ReputationResponse,
} from '../src/api-client.js';
import { discoverTool } from '../src/tools/discover.js';
import { getListingTool } from '../src/tools/get-listing.js';
import { getReputationTool } from '../src/tools/get-reputation.js';

// ---- helpers ----------------------------------------------------------------

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getListings: vi.fn(),
    getListing: vi.fn(),
    getReputation: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

const LISTING_ITEM = {
  pubkey: 'FakeListingPubkey11111111111111111111111111',
  owner: 'FakeOwnerPubkey111111111111111111111111111',
  capability: 'text-summarisation',
  priceUsdcBaseUnits: '1000000',
  slaParams: { maxLatencyMs: 5000, minUptimePct: 99 },
  metadataUri: 'https://example.com/meta.json',
  jobsCompleted: '42',
  reputationScore: 87,
};

const LISTING_DETAIL: ListingDetail = {
  ...LISTING_ITEM,
  satiAgentId: null,
  pricingModel: 'per_job',
  isActive: true,
  endpoint: 'https://agent.example.com',
  metadata: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-04-01T00:00:00Z',
};

// ---- bazaar_discover --------------------------------------------------------

describe('discoverTool', () => {
  it('returns MCP content with listings array', async () => {
    const resp: ListingsResponse = {
      data: [LISTING_ITEM],
      pagination: { total: 1, limit: 20, offset: 0 },
    };
    const client = makeClient({ getListings: vi.fn().mockResolvedValue(resp) });

    const result = await discoverTool({ limit: 20 }, client);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');

    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.listings).toHaveLength(1);
    expect(parsed.listings[0]?.pubkey).toBe(LISTING_ITEM.pubkey);
    expect(parsed.total).toBe(1);
  });

  it('passes capability filter to api client', async () => {
    const mockGetListings = vi.fn().mockResolvedValue({
      data: [],
      pagination: { total: 0, limit: 5, offset: 0 },
    });
    const client = makeClient({ getListings: mockGetListings });

    await discoverTool({ capability: 'translation', limit: 5 }, client);

    expect(mockGetListings).toHaveBeenCalledWith({ capability: 'translation', limit: 5 });
  });

  it('returns empty listings when API returns no results', async () => {
    const client = makeClient({
      getListings: vi.fn().mockResolvedValue({
        data: [],
        pagination: { total: 0, limit: 20, offset: 0 },
      }),
    });

    const result = await discoverTool({ limit: 20 }, client);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.listings).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });

  it('includes required fields in each listing item', async () => {
    const client = makeClient({
      getListings: vi.fn().mockResolvedValue({
        data: [LISTING_ITEM],
        pagination: { total: 1, limit: 20, offset: 0 },
      }),
    });

    const result = await discoverTool({ limit: 20 }, client);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    const item = parsed.listings[0];

    expect(item).toMatchObject({
      pubkey: expect.any(String),
      owner: expect.any(String),
      capability: expect.any(String),
      priceUsdcBaseUnits: expect.any(String),
      jobsCompleted: expect.any(String),
      reputationScore: expect.any(Number),
    });
  });
});

// ---- bazaar_get_listing -----------------------------------------------------

describe('getListingTool', () => {
  it('returns MCP content with full listing detail', async () => {
    const client = makeClient({
      getListing: vi.fn().mockResolvedValue({ data: LISTING_DETAIL }),
    });

    const result = await getListingTool(
      { pubkey: 'FakeListingPubkey11111111111111111111111111' },
      client,
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');

    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.pubkey).toBe(LISTING_DETAIL.pubkey);
    expect(parsed.capability).toBe(LISTING_DETAIL.capability);
    expect(parsed.isActive).toBe(true);
  });

  it('calls api client with the correct pubkey', async () => {
    const mockGetListing = vi.fn().mockResolvedValue({ data: LISTING_DETAIL });
    const client = makeClient({ getListing: mockGetListing });
    const pubkey = 'FakeListingPubkey11111111111111111111111111';

    await getListingTool({ pubkey }, client);

    expect(mockGetListing).toHaveBeenCalledWith(pubkey);
  });
});

// ---- bazaar_get_reputation --------------------------------------------------

describe('getReputationTool', () => {
  it('returns MCP content with reputation fields', async () => {
    const resp: ReputationResponse = {
      data: {
        wallet: 'FakeOwnerPubkey111111111111111111111111111',
        jobsCompleted: '42',
        avgScore: 87.5,
        totalScore: '3675',
        lastUpdated: '2025-04-20T10:00:00Z',
      },
    };
    const client = makeClient({ getReputation: vi.fn().mockResolvedValue(resp) });

    const result = await getReputationTool(
      { agentPubkey: 'FakeOwnerPubkey111111111111111111111111111' },
      client,
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');

    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.jobsCompleted).toBe('42');
    expect(parsed.avgScore).toBe(87.5);
    expect(parsed.lastJobAt).toBe('2025-04-20T10:00:00Z');
  });

  it('calls api client with the correct agentPubkey', async () => {
    const mockGetReputation = vi.fn().mockResolvedValue({
      data: {
        wallet: 'FakeOwnerPubkey111111111111111111111111111',
        jobsCompleted: '0',
        avgScore: 0,
        totalScore: '0',
        lastUpdated: null,
      },
    });
    const client = makeClient({ getReputation: mockGetReputation });
    const agentPubkey = 'FakeOwnerPubkey111111111111111111111111111';

    await getReputationTool({ agentPubkey }, client);

    expect(mockGetReputation).toHaveBeenCalledWith(agentPubkey);
  });

  it('handles zero-state reputation', async () => {
    const resp: ReputationResponse = {
      data: {
        wallet: 'FakeOwnerPubkey111111111111111111111111111',
        jobsCompleted: '0',
        avgScore: 0,
        totalScore: '0',
        lastUpdated: null,
      },
    };
    const client = makeClient({ getReputation: vi.fn().mockResolvedValue(resp) });

    const result = await getReputationTool(
      { agentPubkey: 'FakeOwnerPubkey111111111111111111111111111' },
      client,
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.jobsCompleted).toBe('0');
    expect(parsed.avgScore).toBe(0);
    expect(parsed.lastJobAt).toBeNull();
  });
});
