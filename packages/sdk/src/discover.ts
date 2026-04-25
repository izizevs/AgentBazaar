import type { BazaarRegistry } from '@agentbazaar/idl';
import { BazaarRegistryIDL } from '@agentbazaar/idl';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { type Connection, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { AnchorWallet } from './client.js';
import { DiscoveryAPIError, RPCFallbackFailedError, ValidationError } from './errors.js';
import type { DiscoverInput, ServiceProvider, SlaParams } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const DiscoverInputSchema = z.object({
  capability: z.string().max(256).optional(),
  minReputation: z.number().int().min(0).max(100).optional(),
  maxPrice: z.bigint().nonnegative().optional(),
  maxLatency: z.number().int().positive().optional(),
  sort: z.enum(['price_asc', 'reputation_desc', 'latency_asc']).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

// Wire format returned by the Discovery API
interface APIServiceEntry {
  listing: string;
  owner: string;
  capability: string;
  priceUsdc: string; // serialised bigint
  pricingModel: number;
  sla: {
    maxLatencyMs?: number | null;
    minUptimePct?: number | null;
    responseFormat?: string | null;
    jsonSchemaUri?: string | null;
    customParams?: Array<{ key: string; value: string }>;
  };
  endpoint: string;
  reputation: number;
  jobsCompleted: number;
  isActive: boolean;
}

interface APIResponse {
  services: APIServiceEntry[];
}

function toSlaParams(raw: APIServiceEntry['sla']): SlaParams {
  return {
    maxLatencyMs: raw.maxLatencyMs ?? undefined,
    minUptimePct: raw.minUptimePct ?? undefined,
    responseFormat: raw.responseFormat ?? undefined,
    jsonSchemaUri: raw.jsonSchemaUri ?? undefined,
    customParams: raw.customParams ?? undefined,
  };
}

// ─── Discovery API path ───────────────────────────────────────────────────────

async function fetchFromAPI(
  baseUrl: string,
  input: z.infer<typeof DiscoverInputSchema>,
  limit: number,
): Promise<ServiceProvider[]> {
  const url = new URL('/services', baseUrl);
  if (input.capability) url.searchParams.set('capability', input.capability);
  if (input.minReputation !== undefined)
    url.searchParams.set('minReputation', String(input.minReputation));
  if (input.maxPrice !== undefined) url.searchParams.set('maxPrice', input.maxPrice.toString());
  if (input.maxLatency !== undefined) url.searchParams.set('maxLatency', String(input.maxLatency));
  if (input.sort) url.searchParams.set('sort', input.sort);
  url.searchParams.set('limit', String(limit));

  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new DiscoveryAPIError(
      `Discovery API unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new DiscoveryAPIError(`Discovery API error: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as APIResponse;
  return body.services.map((entry) => ({
    listing: new PublicKey(entry.listing),
    owner: new PublicKey(entry.owner),
    capability: entry.capability,
    priceUsdc: BigInt(entry.priceUsdc),
    pricingModel: entry.pricingModel,
    sla: toSlaParams(entry.sla),
    endpoint: entry.endpoint,
    reputation: entry.reputation,
    jobsCompleted: entry.jobsCompleted,
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
    // capability_hash serialised as hex — original string not available on-chain
    capability: Buffer.from(account.capabilityHash as number[]).toString('hex'),
    priceUsdc: BigInt((account.priceLamports as { toString(): string }).toString()),
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
    // endpoint is stored in IPFS metadata only — not available in RPC fallback
    endpoint: '',
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

  // 1. Try Discovery API
  try {
    return await fetchFromAPI(discoveryApiUrl, validated, limit);
  } catch (err) {
    if (!(err instanceof DiscoveryAPIError)) throw err;
    // fall through to RPC fallback
  }

  // 2. RPC fallback
  try {
    return await fetchFromRPC(connection, wallet, validated, limit);
  } catch (err) {
    throw new RPCFallbackFailedError(
      `RPC fallback failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
