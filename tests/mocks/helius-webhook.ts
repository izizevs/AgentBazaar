/**
 * Fire a synthetic Helius webhook event to the indexer's webhook endpoint.
 * The payload envelope matches HeliusEventSchema from apps/indexer/src/webhooks/types.ts
 * so it passes the indexer's safeParse validation and reaches the event handler.
 */

export interface ServiceListingCreatedPayload {
  /** The on-chain program that emitted the event. */
  programId: string;
  /** The listing PDA (base58). */
  listingAddress: string;
  /** The owner/seller public key (base58). */
  owner: string;
  /** SHA-256 capability hash (hex, 32 bytes). */
  capabilityHash: string;
  /** Raw metadata IPFS CID. */
  metadataUri: string;
  /** Price in USDC micro-units (as string to avoid JSON number precision loss). */
  priceUsdc: string;
  /** Pricing model byte (0–3). */
  pricingModel: number;
  /** Whether the listing is currently active. */
  isActive: boolean;
  /** Transaction signature. */
  signature: string;
  /** Slot this transaction landed in. */
  slot: number;
  /** Unix timestamp (seconds). */
  timestamp: number;
}

/**
 * POST a synthetic `ServiceListingCreated` event to the indexer webhook endpoint.
 * Wraps the app-specific payload in a Helius enhanced-transaction envelope so it
 * passes the indexer's HeliusWebhookPayloadSchema.safeParse() and reaches the
 * event handler (Task #13).  App-specific data lives in `events.ServiceListingCreated`.
 *
 * @param webhookUrl - Full URL of the indexer's /webhook endpoint
 * @param secret     - Full Authorization header value (e.g. "Bearer <token>")
 * @param payload    - Service listing event data
 */
export async function fireServiceListingCreated(
  webhookUrl: string,
  secret: string,
  payload: ServiceListingCreatedPayload,
): Promise<Response> {
  const heliusEvent = {
    description: `ServiceListingCreated by ${payload.owner}`,
    type: 'UNKNOWN',
    source: 'SYSTEM_PROGRAM',
    fee: 5000,
    feePayer: payload.owner,
    signature: payload.signature,
    slot: payload.slot,
    timestamp: payload.timestamp,
    nativeTransfers: [],
    tokenTransfers: [],
    accountData: [
      {
        account: payload.listingAddress,
        nativeBalanceChange: 0,
        tokenBalanceChanges: [],
      },
    ],
    transactionError: null,
    instructions: [
      {
        accounts: [payload.owner, payload.listingAddress],
        data: '',
        programId: payload.programId,
        innerInstructions: [],
      },
    ],
    events: {
      ServiceListingCreated: {
        listingAddress: payload.listingAddress,
        owner: payload.owner,
        capabilityHash: payload.capabilityHash,
        metadataUri: payload.metadataUri,
        priceUsdc: payload.priceUsdc,
        pricingModel: payload.pricingModel,
        isActive: payload.isActive,
      },
    },
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: secret,
    },
    body: JSON.stringify([heliusEvent]),
  });

  if (!response.ok) {
    throw new Error(
      `Webhook delivery failed: ${response.status} ${response.statusText} — ${await response.text()}`,
    );
  }

  return response;
}
