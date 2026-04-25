/**
 * Fire a synthetic Helius webhook event to the indexer's webhook endpoint.
 * Useful for integration tests that need to trigger the event handler without
 * waiting for a real on-chain event to be picked up by Helius.
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
}

/**
 * POST a synthetic `ServiceListingCreated` event to the indexer webhook endpoint.
 * Uses the HELIUS_WEBHOOK_SECRET for the Authorization header, matching how the
 * real Helius service authenticates its deliveries.
 *
 * @param webhookUrl - Full URL of the indexer's /webhook endpoint
 * @param secret     - Value of HELIUS_WEBHOOK_SECRET (the full "Bearer ..." string)
 * @param payload    - Event data to send
 */
export async function fireServiceListingCreated(
  webhookUrl: string,
  secret: string,
  payload: ServiceListingCreatedPayload,
): Promise<Response> {
  const body = JSON.stringify([
    {
      type: 'ServiceListingCreated',
      ...payload,
    },
  ]);

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: secret,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Webhook delivery failed: ${response.status} ${response.statusText} — ${await response.text()}`,
    );
  }

  return response;
}
