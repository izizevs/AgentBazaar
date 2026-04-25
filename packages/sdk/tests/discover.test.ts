import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorWallet } from '../src/client.js';
import { AgentBazaar } from '../src/client.js';
import { discoverServices } from '../src/discover.js';
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

// ─── mock fetch ──────────────────────────────────────────────────────────────

function mockOkResponse(services: ServiceProvider[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      services: services.map((s) => ({
        listing: s.listing.toBase58(),
        owner: s.owner.toBase58(),
        capability: s.capability,
        priceUsdc: s.priceUsdc.toString(),
        pricingModel: s.pricingModel,
        sla: {
          maxLatencyMs: s.sla.maxLatencyMs ?? null,
          minUptimePct: s.sla.minUptimePct ?? null,
          responseFormat: s.sla.responseFormat ?? null,
          jsonSchemaUri: s.sla.jsonSchemaUri ?? null,
          // omit customParams when not set — API returns array or omits the field, never null
          ...(s.sla.customParams !== undefined ? { customParams: s.sla.customParams } : {}),
        },
        endpoint: s.endpoint ?? 'https://agent.example.com',
        reputation: s.reputation,
        jobsCompleted: s.jobsCompleted,
        isActive: s.isActive,
      })),
    }),
  });
}

function mockErrorResponse(status = 500, statusText = 'Internal Server Error') {
  return vi.fn().mockResolvedValue({ ok: false, status, statusText });
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
      services: [{ listing: 'bad', endpoint: 'javascript:alert(1)', priceUsdc: 'not-a-number' }],
    }),
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

  it('accepts empty input (all defaults)', async () => {
    await expect(
      discoverServices(connection, wallet, {}, 'https://api.example.com'),
    ).resolves.toEqual([]);
  });
});

describe('discoverServices — Discovery API path', () => {
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

  it('maps reputation from API response', async () => {
    const provider = makeProvider({ reputation: 95 });
    vi.stubGlobal('fetch', mockOkResponse([provider]));

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results[0]!.reputation).toBe(95);
  });

  it('passes capability filter as query param', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(connection, wallet, { capability: 'text-summarise' }, apiUrl);

    const firstCall = mockFetch.mock.calls[0]!;
    const calledUrl = new URL(firstCall[0] as string);
    expect(calledUrl.searchParams.get('capability')).toBe('text-summarise');
  });

  it('passes minReputation, maxPrice, maxLatency, sort, limit as query params', async () => {
    const mockFetch = mockOkResponse([]);
    vi.stubGlobal('fetch', mockFetch);

    await discoverServices(
      connection,
      wallet,
      {
        minReputation: 70,
        maxPrice: 5_000_000n,
        maxLatency: 1000,
        sort: 'price_asc',
        limit: 10,
      },
      apiUrl,
    );

    const firstCall = mockFetch.mock.calls[0]!;
    const calledUrl = new URL(firstCall[0] as string);
    expect(calledUrl.searchParams.get('minReputation')).toBe('70');
    expect(calledUrl.searchParams.get('maxPrice')).toBe('5000000');
    expect(calledUrl.searchParams.get('maxLatency')).toBe('1000');
    expect(calledUrl.searchParams.get('sort')).toBe('price_asc');
    expect(calledUrl.searchParams.get('limit')).toBe('10');
  });

  it('falls back to RPC on API non-2xx', async () => {
    vi.stubGlobal('fetch', mockErrorResponse(503, 'Service Unavailable'));
    setRpcListings([]);

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results).toEqual([]);
  });

  it('falls back to RPC on network error', async () => {
    vi.stubGlobal('fetch', mockNetworkError());
    setRpcListings([]);

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results).toEqual([]);
  });

  it('M1: falls back to RPC on malformed JSON (SyntaxError → DiscoveryAPIError)', async () => {
    vi.stubGlobal('fetch', mockMalformedJsonResponse());
    setRpcListings([]);

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results).toEqual([]);
  });

  it('M1: falls back to RPC on invalid API response schema (javascript: endpoint rejected)', async () => {
    vi.stubGlobal('fetch', mockInvalidSchemaResponse());
    setRpcListings([]);

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results).toEqual([]);
  });

  it('L1: bad baseUrl TypeError → DiscoveryAPIError → RPC fallback fires', async () => {
    vi.stubGlobal('fetch', mockOkResponse([]));
    setRpcListings([]);

    const results = await discoverServices(connection, wallet, {}, 'not a url');
    expect(results).toEqual([]);
  });
});

describe('discoverServices — RPC fallback', () => {
  const wallet = makeWallet();
  const connection = { commitment: 'confirmed' } as never;
  const apiUrl = 'https://api.agentbazaar.io';

  beforeEach(() => {
    vi.stubGlobal('fetch', mockErrorResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters out inactive listings', async () => {
    setRpcListings([makeRpcListing({ isActive: true }), makeRpcListing({ isActive: false })]);

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results).toHaveLength(1);
    expect(results[0]!.isActive).toBe(true);
  });

  it('L5: sets endpoint to undefined (stored in IPFS metadata, not on-chain)', async () => {
    setRpcListings([makeRpcListing({ isActive: true })]);
    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results[0]!.endpoint).toBeUndefined();
  });

  it('filters by maxPrice', async () => {
    setRpcListings([
      makeRpcListing({ priceUsdc: 1_000_000n, isActive: true }),
      makeRpcListing({ priceUsdc: 5_000_000n, isActive: true }),
    ]);

    const results = await discoverServices(connection, wallet, { maxPrice: 2_000_000n }, apiUrl);
    expect(results).toHaveLength(1);
    expect(results[0]!.priceUsdc).toBe(1_000_000n);
  });

  it('filters by maxLatency', async () => {
    setRpcListings([
      makeRpcListing({ sla: { maxLatencyMs: 300 }, isActive: true }),
      makeRpcListing({ sla: { maxLatencyMs: 2000 }, isActive: true }),
    ]);

    const results = await discoverServices(connection, wallet, { maxLatency: 500 }, apiUrl);
    expect(results).toHaveLength(1);
    expect(results[0]!.sla.maxLatencyMs).toBe(300);
  });

  it('includes listings with null latency when maxLatency filter is set', async () => {
    setRpcListings([makeRpcListing({ sla: {}, isActive: true })]);

    const results = await discoverServices(connection, wallet, { maxLatency: 500 }, apiUrl);
    expect(results).toHaveLength(1);
  });

  it('sets reputation to 0 (not stored on-chain in M0)', async () => {
    setRpcListings([makeRpcListing({ isActive: true })]);

    const results = await discoverServices(connection, wallet, {}, apiUrl);
    expect(results[0]!.reputation).toBe(0);
  });

  it('sorts by price_asc', async () => {
    setRpcListings([
      makeRpcListing({ priceUsdc: 3_000_000n, isActive: true }),
      makeRpcListing({ priceUsdc: 1_000_000n, isActive: true }),
      makeRpcListing({ priceUsdc: 2_000_000n, isActive: true }),
    ]);

    const results = await discoverServices(connection, wallet, { sort: 'price_asc' }, apiUrl);
    expect(results[0]!.priceUsdc).toBe(1_000_000n);
    expect(results[1]!.priceUsdc).toBe(2_000_000n);
    expect(results[2]!.priceUsdc).toBe(3_000_000n);
  });

  it('sorts by reputation_desc (all 0 in RPC fallback, preserves insertion order)', async () => {
    setRpcListings([makeRpcListing({ isActive: true }), makeRpcListing({ isActive: true })]);

    const results = await discoverServices(connection, wallet, { sort: 'reputation_desc' }, apiUrl);
    expect(results).toHaveLength(2);
    expect(results[0]!.reputation).toBe(0);
  });

  it('sorts by latency_asc (nulls last)', async () => {
    setRpcListings([
      makeRpcListing({ sla: {}, isActive: true }),
      makeRpcListing({ sla: { maxLatencyMs: 800 }, isActive: true }),
      makeRpcListing({ sla: { maxLatencyMs: 200 }, isActive: true }),
    ]);

    const results = await discoverServices(connection, wallet, { sort: 'latency_asc' }, apiUrl);
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

    const results = await discoverServices(connection, wallet, { limit: 2 }, apiUrl);
    expect(results).toHaveLength(2);
  });

  it('defaults limit to 50', async () => {
    const many = Array.from({ length: 60 }, () => makeRpcListing({ isActive: true }));
    setRpcListings(many);

    const results = await discoverServices(connection, wallet, {}, apiUrl);
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

  it('L7: minReputation 0 does NOT throw (reputation 0 passes the filter)', async () => {
    setRpcListings([makeRpcListing({ isActive: true })]);

    const results = await discoverServices(connection, wallet, { minReputation: 0 }, apiUrl);
    expect(results).toHaveLength(1);
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

  it('returns ServiceProvider[] from discover()', async () => {
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
});
