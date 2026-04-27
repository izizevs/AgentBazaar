import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorWallet } from '../src/client.js';
import { AgentBazaar } from '../src/client.js';
import { APIResponseSchema, discoverServices, ListingDtoSchema } from '../src/discover.js';
import {
  DegradedDiscoveryError,
  DiscoveryAPIError,
  RPCFallbackFailedError,
  ValidationError,
} from '../src/errors.js';
import type { ServiceProvider } from '../src/types.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeWallet(): AnchorWallet {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: vi.fn(async (tx) => tx),
    signAllTransactions: vi.fn(async (txs) => txs),
  } as unknown as AnchorWallet;
}

function makeProvider(overrides: Partial<ServiceProvider> = {}): ServiceProvider {
  return {
    listing: overrides.listing ?? new PublicKey(Keypair.generate().publicKey),
    owner: overrides.owner ?? new PublicKey(Keypair.generate().publicKey),
    capability: overrides.capability ?? 'text-summarise',
    priceUsdc: overrides.priceUsdc ?? 1_000_000n,
    pricingModel: overrides.pricingModel ?? 0,
    sla: overrides.sla ?? { maxLatencyMs: 500 },
    endpoint: overrides.endpoint ?? 'https://agent.example.com',
    reputation: overrides.reputation ?? 80,
    jobsCompleted: overrides.jobsCompleted ?? 10,
    isActive: overrides.isActive ?? true,
  };
}

// ─── mock fetch helpers ───────────────────────────────────────────────────────
//
// All mocks use the /listings API shape:
//   { data: ListingDto[], pagination: { total, limit, offset } }
//
// ListingDto field names match apps/api/src/routes/listings.ts serializeListing():
//   pubkey, owner, capability, priceUsdcBaseUnits, pricingModel, slaParams,
//   metadataUri, isActive, jobsCompleted, reputationScore, endpoint, metadata,
//   satiAgentId, createdAt, updatedAt.

function makeListingDto(s: ServiceProvider) {
  return {
    pubkey: s.listing.toBase58(),
    owner: s.owner.toBase58(),
    capability: s.capability,
    priceUsdcBaseUnits: s.priceUsdc.toString(),
    pricingModel: s.pricingModel,
    slaParams: {
      maxLatencyMs: s.sla.maxLatencyMs ?? null,
      minUptimePct: s.sla.minUptimePct ?? null,
      responseFormat: s.sla.responseFormat ?? null,
      jsonSchemaUri: s.sla.jsonSchemaUri ?? null,
      customParams: s.sla.customParams ?? [],
    },
    metadataUri: null,
    isActive: s.isActive,
    jobsCompleted: s.jobsCompleted.toString(),
    reputationScore: s.reputation,
    endpoint: s.endpoint ?? null,
    metadata: null,
    satiAgentId: null,
    createdAt: null,
    updatedAt: null,
  };
}

function mockOkResponse(services: ServiceProvider[], total?: number) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: services.map(makeListingDto),
      pagination: {
        total: total ?? services.length,
        limit: services.length || 20,
        offset: 0,
      },
    }),
  });
}

function mockErrorResponse(status = 500, statusText = 'Internal Server Error') {
  return vi.fn().mockResolvedValue({ ok: false, status, statusText, json: async () => ({}) });
}

function mockNetworkError(message = 'connect ECONNREFUSED') {
  return vi.fn().mockRejectedValue(new Error(message));
}

function mockMalformedJsonResponse() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  });
}

function mockInvalidSchemaResponse() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      // Missing required `pagination` and `data` keys → Zod throws → DiscoveryAPIError
      services: [
        { pubkey: 'bad', endpoint: 'javascript:alert(1)', priceUsdcBaseUnits: 'not-a-number' },
      ],
    }),
  });
}

function mock400Response(message = 'Bad Request') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    json: async () => ({ message }),
  });
}

// ─── RPC mock ────────────────────────────────────────────────────────────────

vi.mock('@coral-xyz/anchor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@coral-xyz/anchor')>();
  return {
    ...actual,
    AnchorProvider: vi.fn(),
    Program: vi.fn().mockImplementation(() => ({
      account: {
        serviceListing: {
          all: vi.fn().mockResolvedValue([]),
        },
      },
    })),
  };
});

import { Program } from '@coral-xyz/anchor';

type RpcListing = { publicKey: PublicKey; account: Record<string, unknown> };

function setRpcListings(listings: RpcListing[]) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock cast
  (Program as any).mockImplementation(() => ({
    account: {
      serviceListing: {
        all: vi.fn().mockResolvedValue(listings),
      },
    },
  }));
}

function makeRpcListing(overrides: Partial<ServiceProvider> = {}): RpcListing {
  const p = makeProvider(overrides);
  return {
    publicKey: p.listing,
    account: {
      owner: p.owner,
      capabilityHash: Array.from(Buffer.from(p.capability, 'utf8')),
      priceUsdcBaseUnits: { toString: () => p.priceUsdc.toString() },
      pricingModel: p.pricingModel,
      slaParams: {
        maxLatencyMs: p.sla.maxLatencyMs ?? null,
        minUptimePct: p.sla.minUptimePct ?? null,
        responseFormat: p.sla.responseFormat ?? null,
        jsonSchemaUri: p.sla.jsonSchemaUri ?? null,
        customParams: p.sla.customParams ?? [],
      },
      jobsCompleted: p.jobsCompleted,
      isActive: p.isActive,
    },
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('discoverServices — input validation', () => {
  const wallet = makeWallet();
  const connection = { commitment: 'confirmed' } as never;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockOkResponse([]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects limit > 200', async () => {
    await expect(
      discoverServices(connection, wallet, { limit: 201 }, 'https://api.example.com'),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects limit < 1', async () => {
    await expect(
      discoverServices(connection, wallet, { limit: 0 }, 'https://api.example.com'),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects negative minReputation', async () => {
    await expect(
      discoverServices(connection, wallet, { minReputation: -1 }, 'https://api.example.com'),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects minReputation > 100', async () => {
    await expect(
      discoverServices(connection, wallet, { minReputation: 101 }, 'https://api.example.com'),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects negative maxPrice bigint', async () => {
    await expect(
      discoverServices(connection, wallet, { maxPrice: -1n }, 'https://api.example.com'),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects invalid sort value', async () => {
    await expect(
      discoverServices(
        connection,
        wallet,
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid for test
        { sort: 'invalid' as any },
        'https://api.example.com',
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts empty input (all defaults) — returns via API', async () => {
    await expect(
      discoverServices(connection, wallet, {}, 'https://api.example.com'),
    ).resolves.toEqual([]);
  });
});

describe('discoverServices — Discovery API primary path', () => {
  const wallet = makeWallet();
  const connection = { commitment: 'confirmed' } as never;
  const apiUrl = 'https://api.agentbazaar.io';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns mapped ServiceProvider[] on success', async () => {
    const provider = makeProvider();
    vi.stubGlobal('fetch', mockOkResponse([provider]));

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results).toHaveLength(1);
    const first = results[0]!;
    expect(first.capability).toBe(provider.capability);
    expect(first.priceUsdc).toBe(provider.priceUsdc);
    expect(first.listing.toBase58()).toBe(provider.listing.toBase58());
  });

  it('maps reputationScore from API response to ServiceProvider.reputation', async () => {
    const provider = makeProvider({ reputation: 95 });
    vi.stubGlobal('fetch', mockOkResponse([provider]));

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results[0]!.reputation).toBe(95);
  });

  it('maps priceUsdcBaseUnits string to BigInt priceUsdc', async () => {
    const provider = makeProvider({ priceUsdc: 5_500_000n });
    vi.stubGlobal('fetch', mockOkResponse([provider]));

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results[0]!.priceUsdc).toBe(5_500_000n);
  });

  it('maps jobsCompleted string to number', async () => {
    const provider = makeProvider({ jobsCompleted: 42 });
    vi.stubGlobal('fetch', mockOkResponse([provider]));

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results[0]!.jobsCompleted).toBe(42);
  });

  it('passes capability filter as query param to /listings', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(connection, wallet, { capability: 'text-summarise' }, apiUrl);

    const firstCall = mockFetch.mock.calls[0]!;
    const calledUrl = new URL(firstCall[0] as string);
    expect(calledUrl.pathname).toBe('/listings');
    expect(calledUrl.searchParams.get('capability')).toBe('text-summarise');
  });

  it('passes minReputation, maxPrice, maxLatency, limit as query params', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(
      connection,
      wallet,
      {
        minReputation: 70,
        maxPrice: 5_000_000n,
        maxLatency: 1000,
        limit: 10,
      },
      apiUrl,
    );

    const firstCall = mockFetch.mock.calls[0]!;
    const calledUrl = new URL(firstCall[0] as string);
    expect(calledUrl.searchParams.get('minReputation')).toBe('70');
    expect(calledUrl.searchParams.get('maxPrice')).toBe('5000000');
    expect(calledUrl.searchParams.get('maxLatency')).toBe('1000');
    expect(calledUrl.searchParams.get('limit')).toBe('10');
  });

  // R6: SDK used to send limit=200 → API enforces limit<=100 → 422.
  // SDK now clamps to API_MAX_LIMIT (100) before building the request URL.
  it('R6: clamps limit=200 to 100 in the API request URL (never sends limit > 100)', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(connection, wallet, { limit: 200 }, apiUrl);

    const firstCall = mockFetch.mock.calls[0]!;
    const calledUrl = new URL(firstCall[0] as string);
    expect(calledUrl.searchParams.get('limit')).toBe('100');
    expect(calledUrl.searchParams.get('limit')).not.toBe('200');
  });

  it('R6: does not clamp limit=50 (well within API_MAX_LIMIT)', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(connection, wallet, { limit: 50 }, apiUrl);

    const firstCall = mockFetch.mock.calls[0]!;
    const calledUrl = new URL(firstCall[0] as string);
    expect(calledUrl.searchParams.get('limit')).toBe('50');
  });

  it('maps sort=price_asc to sort=price&order=asc', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(connection, wallet, { sort: 'price_asc' }, apiUrl);

    const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('sort')).toBe('price');
    expect(calledUrl.searchParams.get('order')).toBe('asc');
  });

  it('maps sort=reputation_desc to sort=reputation&order=desc', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(connection, wallet, { sort: 'reputation_desc' }, apiUrl);

    const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('sort')).toBe('reputation');
    expect(calledUrl.searchParams.get('order')).toBe('desc');
  });

  it('maps sort=latency_asc to sort=completedJobs&order=asc', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(connection, wallet, { sort: 'latency_asc' }, apiUrl);

    const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('sort')).toBe('completedJobs');
    expect(calledUrl.searchParams.get('order')).toBe('asc');
  });

  it('hits /listings not /services', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(connection, wallet, {}, apiUrl);

    const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe('/listings');
  });

  it('falls back to RPC and throws DegradedDiscoveryError on 5xx', async () => {
    vi.stubGlobal('fetch', mockErrorResponse(503, 'Service Unavailable'));
    setRpcListings([]);

    await expect(discoverServices(connection, wallet, {}, apiUrl)).rejects.toThrow(
      DegradedDiscoveryError,
    );
  });

  it('DegradedDiscoveryError.rpcResults contains RPC fallback data on 5xx', async () => {
    vi.stubGlobal('fetch', mockErrorResponse(503, 'Service Unavailable'));
    setRpcListings([makeRpcListing({ isActive: true })]);

    const err = await discoverServices(connection, wallet, {}, apiUrl).catch((e) => e);
    expect(err).toBeInstanceOf(DegradedDiscoveryError);
    expect((err as DegradedDiscoveryError<ServiceProvider>).rpcResults).toHaveLength(1);
  });

  it('DegradedDiscoveryError.cause is the original DiscoveryAPIError on 5xx', async () => {
    vi.stubGlobal('fetch', mockErrorResponse(500, 'Internal Server Error'));
    setRpcListings([]);

    const err = await discoverServices(connection, wallet, {}, apiUrl).catch((e) => e);
    expect(err).toBeInstanceOf(DegradedDiscoveryError);
    expect((err as DegradedDiscoveryError).cause).toBeInstanceOf(DiscoveryAPIError);
  });

  it('falls back to RPC and throws DegradedDiscoveryError on network error', async () => {
    vi.stubGlobal('fetch', mockNetworkError());
    setRpcListings([]);

    await expect(discoverServices(connection, wallet, {}, apiUrl)).rejects.toThrow(
      DegradedDiscoveryError,
    );
  });

  it('DegradedDiscoveryError.cause is the DiscoveryAPIError on network error', async () => {
    vi.stubGlobal('fetch', mockNetworkError('connect ECONNREFUSED'));
    setRpcListings([]);

    const err = await discoverServices(connection, wallet, {}, apiUrl).catch((e) => e);
    expect(err).toBeInstanceOf(DegradedDiscoveryError);
    expect((err as DegradedDiscoveryError).cause).toBeInstanceOf(DiscoveryAPIError);
  });

  it('M1: falls back to RPC and throws DegradedDiscoveryError on malformed JSON', async () => {
    vi.stubGlobal('fetch', mockMalformedJsonResponse());
    setRpcListings([]);

    await expect(discoverServices(connection, wallet, {}, apiUrl)).rejects.toThrow(
      DegradedDiscoveryError,
    );
  });

  it('M1: falls back to RPC and throws DegradedDiscoveryError on invalid API response schema', async () => {
    vi.stubGlobal('fetch', mockInvalidSchemaResponse());
    setRpcListings([]);

    await expect(discoverServices(connection, wallet, {}, apiUrl)).rejects.toThrow(
      DegradedDiscoveryError,
    );
  });

  it('L1: bad baseUrl TypeError → DiscoveryAPIError → RPC fallback → DegradedDiscoveryError', async () => {
    vi.stubGlobal('fetch', mockOkResponse([]));
    setRpcListings([]);

    await expect(discoverServices(connection, wallet, {}, 'not a url')).rejects.toThrow(
      DegradedDiscoveryError,
    );
  });

  it('400 from API throws DiscoveryAPIError (no RPC fallback)', async () => {
    vi.stubGlobal('fetch', mock400Response('capability filter too broad'));
    setRpcListings([makeRpcListing({ isActive: true })]);

    await expect(discoverServices(connection, wallet, {}, apiUrl)).rejects.toThrow(
      DiscoveryAPIError,
    );
  });

  it('400 DiscoveryAPIError has correct statusCode', async () => {
    vi.stubGlobal('fetch', mock400Response('bad request'));
    setRpcListings([]);

    const err = await discoverServices(connection, wallet, {}, apiUrl).catch((e) => e);
    expect(err).toBeInstanceOf(DiscoveryAPIError);
    expect((err as DiscoveryAPIError).statusCode).toBe(400);
  });

  it('400 from API does NOT run RPC fallback (Program.account.serviceListing.all not called)', async () => {
    const mockAll = vi.fn().mockResolvedValue([]);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (Program as any).mockImplementation(() => ({
      account: { serviceListing: { all: mockAll } },
    }));
    vi.stubGlobal('fetch', mock400Response());

    await discoverServices(connection, wallet, {}, apiUrl).catch(() => {});

    expect(mockAll).not.toHaveBeenCalled();
  });

  it('AbortSignal timeout → DiscoveryAPIError → RPC fallback → DegradedDiscoveryError', async () => {
    // Simulate AbortSignal timeout by rejecting with a DOMException named TimeoutError
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        (() => {
          const e = new Error('The operation was aborted due to timeout');
          e.name = 'TimeoutError';
          return e;
        })(),
      ),
    );
    setRpcListings([]);

    await expect(discoverServices(connection, wallet, {}, apiUrl)).rejects.toThrow(
      DegradedDiscoveryError,
    );
  });
});

describe('discoverServices — RPC fallback (accessed via DegradedDiscoveryError)', () => {
  const wallet = makeWallet();
  const connection = { commitment: 'confirmed' } as never;
  const apiUrl = 'https://api.agentbazaar.io';

  beforeEach(() => {
    // All tests in this suite simulate API outage → RPC fallback path
    vi.stubGlobal('fetch', mockErrorResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function getRpcResults(err: unknown): ServiceProvider[] {
    expect(err).toBeInstanceOf(DegradedDiscoveryError);
    return [...(err as DegradedDiscoveryError<ServiceProvider>).rpcResults];
  }

  it('filters out inactive listings', async () => {
    setRpcListings([makeRpcListing({ isActive: true }), makeRpcListing({ isActive: false })]);

    const err = await discoverServices(connection, wallet, {}, apiUrl).catch((e) => e);
    const results = getRpcResults(err);
    expect(results).toHaveLength(1);
    expect(results[0]!.isActive).toBe(true);
  });

  it('L5: sets endpoint to undefined (stored in IPFS metadata, not on-chain)', async () => {
    setRpcListings([makeRpcListing({ isActive: true })]);
    const err = await discoverServices(connection, wallet, {}, apiUrl).catch((e) => e);
    const results = getRpcResults(err);
    expect(results[0]!.endpoint).toBeUndefined();
  });

  it('filters by maxPrice', async () => {
    setRpcListings([
      makeRpcListing({ priceUsdc: 1_000_000n, isActive: true }),
      makeRpcListing({ priceUsdc: 5_000_000n, isActive: true }),
    ]);

    const err = await discoverServices(connection, wallet, { maxPrice: 2_000_000n }, apiUrl).catch(
      (e) => e,
    );
    const results = getRpcResults(err);
    expect(results).toHaveLength(1);
    expect(results[0]!.priceUsdc).toBe(1_000_000n);
  });

  it('filters by maxLatency', async () => {
    setRpcListings([
      makeRpcListing({ sla: { maxLatencyMs: 300 }, isActive: true }),
      makeRpcListing({ sla: { maxLatencyMs: 2000 }, isActive: true }),
    ]);

    const err = await discoverServices(connection, wallet, { maxLatency: 500 }, apiUrl).catch(
      (e) => e,
    );
    const results = getRpcResults(err);
    expect(results).toHaveLength(1);
    expect(results[0]!.sla.maxLatencyMs).toBe(300);
  });

  it('includes listings with null latency when maxLatency filter is set', async () => {
    setRpcListings([makeRpcListing({ sla: {}, isActive: true })]);

    const err = await discoverServices(connection, wallet, { maxLatency: 500 }, apiUrl).catch(
      (e) => e,
    );
    const results = getRpcResults(err);
    expect(results).toHaveLength(1);
  });

  it('sets reputation to 0 (not stored on-chain in M0)', async () => {
    setRpcListings([makeRpcListing({ isActive: true })]);

    const err = await discoverServices(connection, wallet, {}, apiUrl).catch((e) => e);
    const results = getRpcResults(err);
    expect(results[0]!.reputation).toBe(0);
  });

  it('sorts by price_asc', async () => {
    setRpcListings([
      makeRpcListing({ priceUsdc: 3_000_000n, isActive: true }),
      makeRpcListing({ priceUsdc: 1_000_000n, isActive: true }),
      makeRpcListing({ priceUsdc: 2_000_000n, isActive: true }),
    ]);

    const err = await discoverServices(connection, wallet, { sort: 'price_asc' }, apiUrl).catch(
      (e) => e,
    );
    const results = getRpcResults(err);
    expect(results[0]!.priceUsdc).toBe(1_000_000n);
    expect(results[1]!.priceUsdc).toBe(2_000_000n);
    expect(results[2]!.priceUsdc).toBe(3_000_000n);
  });

  it('sorts by reputation_desc (all 0 in RPC fallback, preserves insertion order)', async () => {
    setRpcListings([makeRpcListing({ isActive: true }), makeRpcListing({ isActive: true })]);

    const err = await discoverServices(
      connection,
      wallet,
      { sort: 'reputation_desc' },
      apiUrl,
    ).catch((e) => e);
    const results = getRpcResults(err);
    expect(results).toHaveLength(2);
    expect(results[0]!.reputation).toBe(0);
  });

  it('sorts by latency_asc (nulls last)', async () => {
    setRpcListings([
      makeRpcListing({ sla: {}, isActive: true }),
      makeRpcListing({ sla: { maxLatencyMs: 800 }, isActive: true }),
      makeRpcListing({ sla: { maxLatencyMs: 200 }, isActive: true }),
    ]);

    const err = await discoverServices(connection, wallet, { sort: 'latency_asc' }, apiUrl).catch(
      (e) => e,
    );
    const results = getRpcResults(err);
    expect(results[0]?.sla.maxLatencyMs).toBe(200);
    expect(results[1]?.sla.maxLatencyMs).toBe(800);
    expect(results[2]?.sla.maxLatencyMs).toBeUndefined();
  });

  it('respects limit', async () => {
    setRpcListings([
      makeRpcListing({ isActive: true }),
      makeRpcListing({ isActive: true }),
      makeRpcListing({ isActive: true }),
    ]);

    const err = await discoverServices(connection, wallet, { limit: 2 }, apiUrl).catch((e) => e);
    const results = getRpcResults(err);
    expect(results).toHaveLength(2);
  });

  it('defaults limit to 50', async () => {
    const many = Array.from({ length: 60 }, () => makeRpcListing({ isActive: true }));
    setRpcListings(many);

    const err = await discoverServices(connection, wallet, {}, apiUrl).catch((e) => e);
    const results = getRpcResults(err);
    expect(results).toHaveLength(50);
  });

  it('wraps RPC errors in RPCFallbackFailedError', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (Program as any).mockImplementation(() => ({
      account: {
        serviceListing: {
          all: vi.fn().mockRejectedValue(new Error('RPC timeout')),
        },
      },
    }));

    await expect(discoverServices(connection, wallet, {}, apiUrl)).rejects.toThrow(
      RPCFallbackFailedError,
    );
  });

  // L7: reputation is not on-chain in M0; minReputation > 0 would silently return [] via RPC.
  it('L7: throws DegradedDiscoveryError when minReputation > 0 and RPC fallback is active', async () => {
    setRpcListings([makeRpcListing({ isActive: true })]);

    await expect(
      discoverServices(connection, wallet, { minReputation: 50 }, apiUrl),
    ).rejects.toThrow(DegradedDiscoveryError);
  });

  it('L7: DegradedDiscoveryError.filtersDropped includes minReputation', async () => {
    setRpcListings([makeRpcListing({ isActive: true })]);

    const err = await discoverServices(connection, wallet, { minReputation: 1 }, apiUrl).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DegradedDiscoveryError);
    expect((err as DegradedDiscoveryError).filtersDropped).toContain('minReputation');
  });

  it('L7: DegradedDiscoveryError.rpcResults is populated even when minReputation causes degraded', async () => {
    setRpcListings([makeRpcListing({ isActive: true })]);

    const err = await discoverServices(connection, wallet, { minReputation: 1 }, apiUrl).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DegradedDiscoveryError);
    // rpcResults is set (the RPC fetched listings, just can't apply reputation filter)
    expect((err as DegradedDiscoveryError<ServiceProvider>).rpcResults).toBeDefined();
  });

  it('L7: minReputation 0 does NOT throw (reputation 0 passes the filter)', async () => {
    setRpcListings([makeRpcListing({ isActive: true })]);

    // minReputation=0 → no DegradedDiscoveryError about filter, but still DegradedDiscoveryError
    // because the API was unavailable. The rpcResults should be present.
    const err = await discoverServices(connection, wallet, { minReputation: 0 }, apiUrl).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DegradedDiscoveryError);
    expect((err as DegradedDiscoveryError).filtersDropped).not.toContain('minReputation');
    expect((err as DegradedDiscoveryError<ServiceProvider>).rpcResults).toHaveLength(1);
  });
});

describe('discoverServices — error class hierarchy', () => {
  it('DiscoveryAPIError is instanceof AgentBazaarError', async () => {
    const err = new DiscoveryAPIError('test');
    const { AgentBazaarError } = await import('../src/errors.js');
    expect(err).toBeInstanceOf(AgentBazaarError);
    expect(err.name).toBe('DiscoveryAPIError');
  });

  it('RPCFallbackFailedError is instanceof AgentBazaarError', async () => {
    const err = new RPCFallbackFailedError('test');
    const { AgentBazaarError } = await import('../src/errors.js');
    expect(err).toBeInstanceOf(AgentBazaarError);
    expect(err.name).toBe('RPCFallbackFailedError');
  });

  it('DegradedDiscoveryError is instanceof AgentBazaarError', async () => {
    const err = new DegradedDiscoveryError([]);
    const { AgentBazaarError } = await import('../src/errors.js');
    expect(err).toBeInstanceOf(AgentBazaarError);
    expect(err.name).toBe('DegradedDiscoveryError');
  });

  it('DegradedDiscoveryError.rpcResults defaults to empty array', () => {
    const err = new DegradedDiscoveryError([]);
    expect(err.rpcResults).toEqual([]);
  });

  it('DegradedDiscoveryError.rpcResults is frozen', () => {
    const err = new DegradedDiscoveryError<ServiceProvider>([], {
      rpcResults: [makeProvider()],
    });
    expect(Object.isFrozen(err.rpcResults)).toBe(true);
  });
});

describe('discoverServices — Zod schema fixture regression', () => {
  // Validates APIResponseSchema against a canonical fixture that mirrors the exact
  // JSON shape returned by GET /listings in apps/api/src/routes/listings.ts.
  const validFixture = {
    data: [
      {
        pubkey: '11111111111111111111111111111112',
        owner: '11111111111111111111111111111112',
        capability: 'text-summarise',
        priceUsdcBaseUnits: '1000000',
        pricingModel: 0,
        slaParams: {
          maxLatencyMs: 500,
          minUptimePct: 9900,
          responseFormat: 'json',
          jsonSchemaUri: 'ipfs://Qm123',
          customParams: [{ key: 'model', value: 'gpt-4o' }],
        },
        metadataUri: 'ipfs://QmFoo',
        isActive: true,
        jobsCompleted: '42',
        reputationScore: 87,
        endpoint: 'https://agent.example.com/run',
        metadata: { name: 'My Agent' },
        satiAgentId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    ],
    pagination: {
      total: 1,
      limit: 20,
      offset: 0,
    },
  };

  it('parses a canonical API fixture without error', () => {
    expect(() => APIResponseSchema.parse(validFixture)).not.toThrow();
  });

  it('parses all ListingDto fields correctly', () => {
    const parsed = APIResponseSchema.parse(validFixture);
    const item = parsed.data[0]!;
    expect(item.pubkey).toBe('11111111111111111111111111111112');
    expect(item.priceUsdcBaseUnits).toBe('1000000');
    expect(item.reputationScore).toBe(87);
    expect(item.jobsCompleted).toBe('42');
    expect(item.slaParams?.maxLatencyMs).toBe(500);
    expect(item.slaParams?.customParams).toHaveLength(1);
  });

  it('rejects fixture with invalid pubkey', () => {
    const bad = JSON.parse(JSON.stringify(validFixture));
    bad.data[0].pubkey = 'not-a-pubkey!';
    expect(() => APIResponseSchema.parse(bad)).toThrow();
  });

  it('rejects fixture with missing pagination', () => {
    const bad = { data: validFixture.data };
    expect(() => APIResponseSchema.parse(bad)).toThrow();
  });

  it('rejects fixture with non-decimal priceUsdcBaseUnits', () => {
    const bad = JSON.parse(JSON.stringify(validFixture));
    bad.data[0].priceUsdcBaseUnits = '1.5';
    expect(() => APIResponseSchema.parse(bad)).toThrow();
  });

  it('ListingDtoSchema allows nullable capability', () => {
    const row = JSON.parse(JSON.stringify(validFixture.data[0]));
    row.capability = null;
    expect(() => ListingDtoSchema.parse(row)).not.toThrow();
  });

  it('ListingDtoSchema allows nullable slaParams', () => {
    const row = JSON.parse(JSON.stringify(validFixture.data[0]));
    row.slaParams = null;
    expect(() => ListingDtoSchema.parse(row)).not.toThrow();
  });
});

describe('AgentBazaar.discover() — client integration', () => {
  beforeEach(() => {
    setRpcListings([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses discoveryApiUrl from config', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    const client = new AgentBazaar({
      wallet: makeWallet(),
      rpc: 'https://api.devnet.solana.com',
      discoveryApiUrl: 'https://custom.api.example.com',
    });

    expect(client.discoveryApiUrl).toBe('https://custom.api.example.com');
    await client.discover({});

    const firstCall = mockFetch.mock.calls[0]!;
    const calledUrl = new URL(firstCall[0] as string);
    expect(calledUrl.origin).toBe('https://custom.api.example.com');
  });

  it('defaults discoveryApiUrl to localhost:8787 when not set and env not set', () => {
    const client = new AgentBazaar({
      wallet: makeWallet(),
      rpc: 'https://api.devnet.solana.com',
    });
    expect(client.discoveryApiUrl).toBe('http://localhost:8787');
  });

  it('returns ServiceProvider[] from discover() on API success', async () => {
    const provider = makeProvider();
    vi.stubGlobal('fetch', mockOkResponse([provider]));

    const client = new AgentBazaar({
      wallet: makeWallet(),
      rpc: 'https://api.devnet.solana.com',
      discoveryApiUrl: 'https://api.agentbazaar.io',
    });

    const results = await client.discover({ capability: 'text-summarise' });
    expect(results).toHaveLength(1);
    expect(results[0]?.endpoint).toBe(provider.endpoint);
  });

  it('throws DegradedDiscoveryError with rpcResults on API 5xx', async () => {
    vi.stubGlobal('fetch', mockErrorResponse(503, 'Service Unavailable'));
    setRpcListings([makeRpcListing({ isActive: true })]);

    const client = new AgentBazaar({
      wallet: makeWallet(),
      rpc: 'https://api.devnet.solana.com',
      discoveryApiUrl: 'https://api.agentbazaar.io',
    });

    const err = await client.discover({}).catch((e) => e);
    expect(err).toBeInstanceOf(DegradedDiscoveryError);
    expect((err as DegradedDiscoveryError<ServiceProvider>).rpcResults).toHaveLength(1);
  });

  it('throws DiscoveryAPIError on 400 without RPC fallback', async () => {
    vi.stubGlobal('fetch', mock400Response('bad filter'));

    const client = new AgentBazaar({
      wallet: makeWallet(),
      rpc: 'https://api.devnet.solana.com',
      discoveryApiUrl: 'https://api.agentbazaar.io',
    });

    const err = await client.discover({}).catch((e) => e);
    expect(err).toBeInstanceOf(DiscoveryAPIError);
    expect((err as DiscoveryAPIError).statusCode).toBe(400);
  });
});

// ─── Integration test (real API — skipped unless INTEGRATION=true) ────────────

describe('discoverServices — integration (real API)', () => {
  const INTEGRATION = process.env.INTEGRATION === 'true';
  const REAL_API_URL = 'https://agentbazaar-api.r-443.workers.dev';

  it.skipIf(!INTEGRATION)(
    'fetches real /listings from production API',
    async () => {
      const wallet = makeWallet();
      const connection = { commitment: 'confirmed' } as never;

      const result = await discoverServices(connection, wallet, { limit: 5 }, REAL_API_URL).catch(
        (err) => {
          // On degraded state, surface the rpcResults
          if (err instanceof DegradedDiscoveryError) return err.rpcResults;
          throw err;
        },
      );

      expect(Array.isArray(result)).toBe(true);
      // Each entry should be a valid ServiceProvider
      for (const item of result as ServiceProvider[]) {
        expect(item.listing).toBeDefined();
        expect(typeof item.capability).toBe('string');
        expect(typeof item.isActive).toBe('boolean');
      }
    },
    15_000,
  ); // 15 s timeout for network call
});
