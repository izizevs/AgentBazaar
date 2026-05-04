import type { BazaarRegistry } from '@agent-bazaar/idl';
import { BazaarRegistryIDL } from '@agent-bazaar/idl';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { type Connection, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { AnchorWallet } from './client.js';
import {
  DegradedDiscoveryError,
  DiscoveryAPIError,
  RPCFallbackFailedError,
  ValidationError,
} from './errors.js';
import type { DiscoverInput, ServiceProvider, SlaParams } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// apps/api Zod schema enforces limit <= 100; clamp before building the request URL.
const API_MAX_LIMIT = 100;

const DiscoverInputSchema = z.object({
  capability: z.string().max(256).optional(),
  minReputation: z.number().int().min(0).max(100).optional(),
  maxPrice: z.bigint().nonnegative().optional(),
  maxLatency: z.number().int().positive().optional(),
  sort: z.enum(['price_asc', 'reputation_desc', 'latency_asc']).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

// O8: base58 refinement ensures invalid pubkeys throw DiscoveryAPIError → fallback, not uncaught TypeError.
const isBase58PublicKey = (s: string) => {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
};

// ─── Zod schema for the /listings API response ────────────────────────────────
//
// Matches apps/api/src/routes/listings.ts `serializeListing()` output.
// GET /listings → { data: ListingDto[], pagination: { total, limit, offset } }

export const ListingDtoSchema = z.object({
  // On-chain address of the ServiceListing PDA (base58).
  pubkey: z.string().refine(isBase58PublicKey, 'Invalid base58 public key'),
  // Owner wallet (base58).
  owner: z.string().refine(isBase58PublicKey, 'Invalid base58 public key'),
  // Human-readable capability string resolved by the indexer (nullable when not yet decoded).
  capability: z.string().max(256).nullable(),
  // Price in USDC micro-units, serialised as a decimal string (BigInt transport).
  priceUsdcBaseUnits: z
    .string()
    .regex(/^\d+$/, 'priceUsdcBaseUnits must be a decimal string')
    .nullable(),
  // Pricing model enum value (0=per_request, 1=per_job, 2=hourly, 3=subscription).
  pricingModel: z.number().int().min(0).max(3).nullable(),
  // SLA parameters stored as JSONB on the indexer.
  slaParams: z
    .object({
      maxLatencyMs: z.number().int().nonnegative().nullable(),
      minUptimePct: z.number().int().min(0).max(10_000).nullable(),
      responseFormat: z.string().max(16).nullable(),
      jsonSchemaUri: z.string().max(64).nullable(),
      customParams: z
        .array(z.object({ key: z.string().max(16), value: z.string().max(32) }))
        .max(2),
    })
    .nullable(),
  // IPFS/Arweave metadata URI.
  metadataUri: z.string().nullable(),
  isActive: z.boolean(),
  // Jobs completed count, serialised as decimal string.
  jobsCompleted: z.string().regex(/^\d+$/, 'jobsCompleted must be a decimal string').nullable(),
  // Off-chain reputation score resolved by the indexer (0–100).
  reputationScore: z.number().int().min(0).max(100).nullable(),
  // HTTPS endpoint (from metadata, resolved by the indexer). Nullable when not yet populated.
  endpoint: z.string().nullable(),
  // Arbitrary metadata JSON blob.
  metadata: z.unknown().nullable(),
  satiAgentId: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const APIResponseSchema = z.object({
  data: z.array(ListingDtoSchema).max(MAX_LIMIT),
  pagination: z.object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  }),
});

export type ListingDto = z.infer<typeof ListingDtoSchema>;

function toSlaParams(raw: ListingDto['slaParams']): SlaParams {
  if (!raw) return {};
  return {
    maxLatencyMs: raw.maxLatencyMs ?? undefined,
    minUptimePct: raw.minUptimePct ?? undefined,
    responseFormat: raw.responseFormat ?? undefined,
    jsonSchemaUri: raw.jsonSchemaUri ?? undefined,
    customParams: raw.customParams.length > 0 ? raw.customParams : undefined,
  };
}

// ─── Discovery API path ───────────────────────────────────────────────────────

async function fetchFromAPI(
  baseUrl: string,
  input: z.infer<typeof DiscoverInputSchema>,
  limit: number,
): Promise<ServiceProvider[]> {
  // L1: URL construction inside try so a bad baseUrl becomes DiscoveryAPIError
  let res: Response;
  try {
    const url = new URL('/listings', baseUrl);
    if (input.capability) url.searchParams.set('capability', input.capability);
    if (input.minReputation !== undefined)
      url.searchParams.set('minReputation', String(input.minReputation));
    if (input.maxPrice !== undefined) url.searchParams.set('maxPrice', input.maxPrice.toString());
    if (input.maxLatency !== undefined)
      url.searchParams.set('maxLatency', String(input.maxLatency));
    // Map SDK sort enum to API sort + order query params
    if (input.sort === 'price_asc') {
      url.searchParams.set('sort', 'price');
      url.searchParams.set('order', 'asc');
    } else if (input.sort === 'reputation_desc') {
      url.searchParams.set('sort', 'reputation');
      url.searchParams.set('order', 'desc');
    } else if (input.sort === 'latency_asc') {
      url.searchParams.set('sort', 'completedJobs');
      url.searchParams.set('order', 'asc');
    }
    // Clamp to API_MAX_LIMIT (100) — apps/api Zod schema rejects limit > 100 with 422.
    const apiLimit = Math.min(limit, API_MAX_LIMIT);
    url.searchParams.set('limit', String(apiLimit));
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new DiscoveryAPIError(
      `Discovery API unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 4xx = client error (bad params, auth, etc.) — surface immediately, do NOT fall back.
  // 5xx = server error — signal caller to fall back via DiscoveryAPIError (statusCode set).
  if (!res.ok) {
    let errorMessage = `${res.status} ${res.statusText}`;
    if (res.status >= 400 && res.status < 500) {
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        if (body?.message) errorMessage = body.message;
        else if (body?.error) errorMessage = body.error;
      } catch {
        // ignore JSON parse failure when reading error body
      }
      throw new DiscoveryAPIError(`Discovery API client error: ${errorMessage}`, res.status);
    }
    throw new DiscoveryAPIError(
      `Discovery API server error: ${res.status} ${res.statusText}`,
      res.status,
    );
  }

  // M1: Zod-validate response; L2: json() SyntaxError → DiscoveryAPIError → triggers RPC fallback
  let parsed: z.infer<typeof APIResponseSchema>;
  try {
    parsed = APIResponseSchema.parse(await res.json());
  } catch (err) {
    throw new DiscoveryAPIError(
      `Discovery API response invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parsed.data.map((entry) => ({
    listing: new PublicKey(entry.pubkey),
    owner: new PublicKey(entry.owner),
    capability: entry.capability ?? '',
    priceUsdc: BigInt(entry.priceUsdcBaseUnits ?? '0'),
    pricingModel: entry.pricingModel ?? 0,
    sla: toSlaParams(entry.slaParams),
    endpoint: entry.endpoint ?? undefined,
    reputation: entry.reputationScore ?? 0,
    jobsCompleted: Number(entry.jobsCompleted ?? '0'),
    isActive: entry.isActive,
  }));
}

// ─── RPC fallback ─────────────────────────────────────────────────────────────

function applyFiltersAndSort(
  results: ServiceProvider[],
  input: z.infer<typeof DiscoverInputSchema>,
  limit: number,
): ServiceProvider[] {
  let out = results.filter((r) => r.isActive);

  if (input.minReputation !== undefined) {
    out = out.filter((r) => r.reputation >= (input.minReputation as number));
  }
  if (input.maxPrice !== undefined) {
    out = out.filter((r) => r.priceUsdc <= (input.maxPrice as bigint));
  }
  if (input.maxLatency !== undefined) {
    const maxMs = input.maxLatency as number;
    out = out.filter((r) => r.sla.maxLatencyMs == null || r.sla.maxLatencyMs <= maxMs);
  }

  switch (input.sort) {
    case 'price_asc':
      out.sort((a, b) => (a.priceUsdc < b.priceUsdc ? -1 : a.priceUsdc > b.priceUsdc ? 1 : 0));
      break;
    case 'reputation_desc':
      out.sort((a, b) => b.reputation - a.reputation);
      break;
    case 'latency_asc':
      out.sort((a, b) => {
        const la = a.sla.maxLatencyMs ?? Number.MAX_SAFE_INTEGER;
        const lb = b.sla.maxLatencyMs ?? Number.MAX_SAFE_INTEGER;
        return la - lb;
      });
      break;
  }

  return out.slice(0, limit);
}

async function fetchFromRPC(
  connection: Connection,
  wallet: AnchorWallet,
  input: z.infer<typeof DiscoverInputSchema>,
  limit: number,
): Promise<ServiceProvider[]> {
  // biome-ignore lint/suspicious/noExplicitAny: Anchor wallet compatibility
  const provider = new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
  const program = new Program<BazaarRegistry>(BazaarRegistryIDL, provider);

  const allListings = await program.account.serviceListing.all();

  const mapped: ServiceProvider[] = allListings.map(({ publicKey, account }) => ({
    listing: publicKey,
    owner: account.owner as PublicKey,
    // L4: capability is the hex of the on-chain capability_hash — the original string is not
    // stored on-chain (M0). API path returns the human-readable string; callers must handle both.
    capability: Buffer.from(account.capabilityHash as number[]).toString('hex'),
    priceUsdc: BigInt((account.priceUsdcBaseUnits as { toString(): string }).toString()),
    pricingModel: account.pricingModel as number,
    sla: {
      maxLatencyMs:
        (account.slaParams as { maxLatencyMs: number | null }).maxLatencyMs ?? undefined,
      minUptimePct:
        (account.slaParams as { minUptimePct: number | null }).minUptimePct ?? undefined,
      responseFormat:
        (account.slaParams as { responseFormat: string | null }).responseFormat ?? undefined,
      jsonSchemaUri:
        (account.slaParams as { jsonSchemaUri: string | null }).jsonSchemaUri ?? undefined,
      customParams: (account.slaParams as { customParams: Array<{ key: string; value: string }> })
        .customParams,
    },
    // L5: endpoint is in IPFS metadata only — undefined signals "not available" in RPC fallback
    endpoint: undefined,
    // reputation_score is not stored on-chain in M0; set to 0 for RPC fallback results
    reputation: 0,
    jobsCompleted: account.jobsCompleted as number,
    isActive: account.isActive as boolean,
  }));

  return applyFiltersAndSort(mapped, input, limit);
}

// ─── main discover flow ───────────────────────────────────────────────────────

export async function discoverServices(
  connection: Connection,
  wallet: AnchorWallet,
  input: DiscoverInput,
  discoveryApiUrl: string,
): Promise<ServiceProvider[]> {
  const parseResult = DiscoverInputSchema.safeParse(input);
  if (!parseResult.success) {
    throw new ValidationError(parseResult.error.message);
  }

  const validated = parseResult.data;
  const limit = validated.limit ?? DEFAULT_LIMIT;

  // 1. Try Discovery API (primary path)
  let apiError: DiscoveryAPIError | undefined;
  try {
    return await fetchFromAPI(discoveryApiUrl, validated, limit);
  } catch (err) {
    if (!(err instanceof DiscoveryAPIError)) throw err;
    // 4xx = client error — surface immediately, RPC fallback won't fix bad params
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      throw err;
    }
    // Network error, timeout, 5xx, schema validation failure → try RPC fallback
    apiError = err;
  }

  // 2. RPC fallback (once, on network error / 5xx / schema failure)
  let rpcResults: ServiceProvider[];
  try {
    rpcResults = await fetchFromRPC(connection, wallet, validated, limit);
  } catch (err) {
    throw new RPCFallbackFailedError(
      `RPC fallback failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // L7: reputation_score is not on-chain in M0; RPC results always have reputation=0.
  // Applying minReputation would silently return empty results — throw instead so the
  // caller can surface "reputation filtering unavailable" rather than an empty list.
  // Still attach rpcResults so callers can inspect what was available.
  if (validated.minReputation !== undefined && validated.minReputation > 0) {
    throw new DegradedDiscoveryError<ServiceProvider>(['minReputation'], {
      cause: apiError,
      rpcResults,
    });
  }

  // Throw DegradedDiscoveryError so callers know they are in degraded mode.
  // The rpcResults are attached so callers can choose to use them despite the API failure.
  throw new DegradedDiscoveryError<ServiceProvider>([], {
    cause: apiError,
    rpcResults,
  });
}
