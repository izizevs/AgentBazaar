// Thin fetch wrapper around the AgentBazaar Discovery REST API.
// The MCP server delegates all data access here — no direct DB access.

export interface ListingItem {
  pubkey: string;
  owner: string;
  capability: string | null;
  priceUsdcBaseUnits: string | null;
  slaParams: unknown;
  metadataUri: string | null;
  jobsCompleted: string | null;
  reputationScore: number | null;
}

export interface ListingsResponse {
  data: ListingItem[];
  pagination: { total: number; limit: number; offset: number };
}

export interface ListingDetail extends ListingItem {
  satiAgentId: string | null;
  pricingModel: string | null;
  isActive: boolean | null;
  endpoint: string | null;
  metadata: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReputationResponse {
  data: {
    wallet: string;
    jobsCompleted: string;
    avgScore: number;
    totalScore: string;
    lastUpdated: string | null;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API error ${status}: ${body}`);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Trim trailing slash for consistent URL construction
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
        // CF Workers fetch has a 30-second default timeout; no need to add one manually
      });
    } catch (err) {
      throw new Error(
        `Failed to reach Discovery API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new ApiError(res.status, text);
    }
    return JSON.parse(text) as T;
  }

  async getListings(params: { capability?: string; limit?: number }): Promise<ListingsResponse> {
    const qs = new URLSearchParams();
    if (params.capability) qs.set('capability', params.capability);
    qs.set('limit', String(params.limit ?? 20));
    return this.get<ListingsResponse>(`/listings?${qs.toString()}`);
  }

  async getListing(pubkey: string): Promise<{ data: ListingDetail }> {
    return this.get<{ data: ListingDetail }>(`/listings/${encodeURIComponent(pubkey)}`);
  }

  async getReputation(agentPubkey: string): Promise<ReputationResponse> {
    return this.get<ReputationResponse>(`/agents/${encodeURIComponent(agentPubkey)}/reputation`);
  }
}
