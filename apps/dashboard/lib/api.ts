// Typed fetch helpers for the AgentBazaar Discovery API

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://agentbazaar-api.r-443.workers.dev';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SlaParams {
  maxLatencyMs?: number;
  minUptimePct?: number;
  responseFormat?: string;
}

export interface Listing {
  pubkey: string;
  name: string;
  description: string;
  capability: string;
  priceUsdc: number; // in micro-units (6 decimals)
  pricingModel: string;
  sla: SlaParams;
  reputation: number;
  jobsCompleted: number;
  isActive: boolean;
  owner: string;
  satiHandle?: string;
  avatar?: string;
  endpoint?: string;
}

export interface ReputationEntry {
  score: number;
  tags: string[];
  createdAt: string;
  buyer: string;
}

export interface AgentDetail extends Listing {
  totalEarnedUsdc: number;
  slaPct90d: number;
  services: Listing[];
  reputation: number;
  reputationHistory: ReputationEntry[];
}

export interface PaginatedListings {
  items: Listing[];
  total: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// ─── API calls ────────────────────────────────────────────────────────────────

export interface ListingsQuery {
  capability?: string;
  minReputation?: number;
  maxPrice?: number;
  maxLatency?: number;
  sort?: 'reputation_desc' | 'price_asc' | 'latency_asc';
  limit?: number;
  offset?: number;
}

export async function fetchListings(query: ListingsQuery = {}): Promise<PaginatedListings> {
  const params = new URLSearchParams();
  if (query.capability) params.set('capability', query.capability);
  if (query.minReputation !== undefined) params.set('minReputation', String(query.minReputation));
  if (query.maxPrice !== undefined) params.set('maxPrice', String(query.maxPrice));
  if (query.maxLatency !== undefined) params.set('maxLatency', String(query.maxLatency));
  if (query.sort) {
    // API contract: sort=reputation|price|completedJobs + order=asc|desc separately
    const map: Record<string, { sort: string; order: 'asc' | 'desc' }> = {
      reputation_desc: { sort: 'reputation', order: 'desc' },
      price_asc: { sort: 'price', order: 'asc' },
      latency_asc: { sort: 'completedJobs', order: 'asc' }, // best-effort: no latency col
    };
    const m = map[query.sort];
    if (m) {
      params.set('sort', m.sort);
      params.set('order', m.order);
    }
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const qs = params.toString();
  try {
    const result = await apiFetch<
      | { data?: Listing[]; pagination?: { total?: number }; items?: Listing[]; total?: number }
      | Listing[]
    >(`/listings${qs ? `?${qs}` : ''}`);
    // Handle paginated `{data, pagination}` (current API), legacy `{items, total}`, or raw array
    if (Array.isArray(result)) {
      return { items: result, total: result.length };
    }
    const items = result.data ?? result.items ?? [];
    const total = result.pagination?.total ?? result.total ?? items.length;
    return { items, total };
  } catch {
    return { items: [], total: 0 };
  }
}

export async function fetchListing(pubkey: string): Promise<Listing | null> {
  try {
    return await apiFetch<Listing>(`/listings/${pubkey}`);
  } catch {
    return null;
  }
}

export async function fetchAgentReputation(pubkey: string): Promise<ReputationEntry[]> {
  try {
    const result = await apiFetch<ReputationEntry[] | { items: ReputationEntry[] }>(
      `/agents/${pubkey}/reputation`,
    );
    return Array.isArray(result) ? result : (result.items ?? []);
  } catch {
    return [];
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Format USDC micro-units to human-readable string */
export function formatUsdc(microUnits: number): string {
  const val = microUnits / 1_000_000;
  return val.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format USDC micro-units to dollar amount */
export function toUsdc(microUnits: number | bigint): number {
  return Number(microUnits) / 1_000_000;
}

/** Format a Solana public key to a truncated display string */
export function truncatePubkey(pubkey: string, chars = 4): string {
  if (pubkey.length <= chars * 2 + 3) return pubkey;
  return `${pubkey.slice(0, chars)}…${pubkey.slice(-chars)}`;
}

/** Generate a deterministic SATI-style handle from pubkey */
export function satiHandle(pubkey: string): string {
  // Use a simple hash of the first 8 chars + last 4 chars pattern
  const prefix = pubkey
    .slice(0, 6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x');
  return `${prefix}.sati`;
}

/** DiceBear avatar URL for a given seed */
export function diceBearUrl(seed: string): string {
  return `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(seed)}`;
}

/** Map pricing model number/string to label */
export function pricingLabel(model: string | number): string {
  const labels: Record<string, string> = {
    per_request: '/request',
    per_job: '/job',
    hourly: '/hr',
    subscription: '/mo',
    '0': '/request',
    '1': '/job',
    '2': '/hr',
    '3': '/mo',
  };
  return labels[String(model)] ?? '/job';
}
