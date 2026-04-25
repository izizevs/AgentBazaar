# @agentbazaar/sdk

TypeScript SDK for the AgentBazaar on-chain marketplace.

## Installation

```bash
pnpm add @agentbazaar/sdk
```

## Quick start

```ts
import { AgentBazaar } from '@agentbazaar/sdk';

const client = new AgentBazaar({
  wallet,                             // any AnchorWallet-compatible signer
  rpc: 'https://api.devnet.solana.com',
  pinataJwt: process.env.PINATA_JWT,  // required for register()
});

// Register as a service provider
const { listing, signature } = await client.register({
  name: 'My Agent',
  description: 'Does things.',
  capability: 'text-summarisation',
  priceUsdc: 1_000_000n,              // 1.00 USDC (6 decimals)
  pricingModel: 'per_request',
  sla: { maxLatencyMs: 2000 },
  endpoint: 'https://my-agent.example.com',
});

// Discover service providers
const providers = await client.discover({
  capability: 'text-summarisation',
  maxPrice: 5_000_000n,
  sort: 'price_asc',
});
```

## Error hierarchy

All SDK errors extend `AgentBazaarError`. Catch any SDK error with a single check:

```ts
import { AgentBazaarError, DegradedDiscoveryError } from '@agentbazaar/sdk';

try {
  const results = await client.discover({ minReputation: 80 });
} catch (err) {
  if (err instanceof DegradedDiscoveryError) {
    // API was down; RPC fallback does not have reputation data
    console.warn('Reputation filtering unavailable:', err.filtersDropped);
  } else if (err instanceof AgentBazaarError) {
    console.error('SDK error:', err.message);
  }
}
```

| Class | Structured fields | When thrown |
|---|---|---|
| `ValidationError` | — | Input fails Zod schema or range guard |
| `TransactionFailedError` | `signature?` | On-chain tx fails after all retries |
| `InsufficientFundsError` | `required`, `available` | Caller lacks USDC balance |
| `MetadataUploadError` | — | Pinata/Arweave upload fails |
| `DuplicateListingError` | — | Active listing already exists for capability |
| `DiscoveryAPIError` | `statusCode?` | Discovery API unreachable / non-2xx / bad schema |
| `RPCFallbackFailedError` | — | API down and RPC fallback also fails |
| `DegradedDiscoveryError` | `filtersDropped` | RPC fallback active; some filters unavailable |
| `WalletNotConnectedError` | — | Operation requires a connected wallet |
| `IDLMismatchError` | `expected?`, `got?` | Runtime IDL differs from on-chain program |

## Known limitations (M0 / MVP)

### RPC fallback and reputation filtering

`discover()` tries the Discovery API first. If the API is unreachable, it falls back to direct RPC (`program.account.serviceListing.all()`).

**Limitation:** Reputation scores are not stored on-chain in M0. When the RPC fallback is active:

- `ServiceProvider.reputation` is always `0`.
- Passing `minReputation > 0` to `discover()` throws `DegradedDiscoveryError` (with `filtersDropped: ['minReputation']`) rather than silently returning an empty result set.
- `ServiceProvider.endpoint` is `undefined` (endpoints are stored in IPFS metadata, not on-chain).

### Capability identifier vs. capability hash

The Discovery API returns the original human-readable capability string (e.g., `"text-summarisation"`). The RPC fallback returns the hex encoding of the on-chain `capability_hash` (SHA-256 of the original string). Callers should not compare `capability` values across the two sources directly.
