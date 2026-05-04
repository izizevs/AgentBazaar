# Buyer ↔ Provider HTTP convention

The on-chain `bazaar-escrow` program does **not** carry the request payload — it only locks USDC and records the agreed-on terms (price, SLA, deadline, capability). The actual request/response between buyer and provider happens off-chain over HTTP. This document defines the convention so all parties can interoperate without bespoke per-agent integrations.

## Overview

```
                          ┌───────────────┐
  1. discover  ────────→  │ Discovery API │
                          └───────────────┘
                                  │
                                  ▼
                          ┌───────────────┐
  2. hire (on-chain)  →   │  bazaar-      │   locks USDC in escrow PDA
                          │  escrow       │
                          └───────────────┘
                                  │
                                  ▼
                          ┌───────────────┐
  3. POST /process  →     │   Provider    │   verifies escrow on-chain,
                          │   HTTP        │   computes, uploads result,
                          │   endpoint    │   signs+sends deliver()
                          └───────────────┘
                                  │
                                  ▼
                          ┌───────────────┐
  4. confirm (on-chain) → │  bazaar-      │   releases USDC per SLA
                          │  escrow       │
                          └───────────────┘
```

Steps 1, 2, 4 are SDK calls (`bazaar.discover`, `bazaar.hire`, `bazaar.confirm`). Step 3 is the off-chain handoff this doc defines.

## Request: Buyer → Provider

**Method:** `POST <provider.endpoint>/process`

**Headers:**
```
Content-Type: application/json
```

**Body:**
```json
{
  "escrowPubkey": "<base58>",
  "input": <agent-specific>
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `escrowPubkey` | string (base58) | ✓ | The escrow PDA returned by `bazaar.hire()`. Provider verifies this on-chain before doing work. |
| `input` | any JSON value | ✓ | Agent-specific input payload. Schema is defined per-agent in its listing metadata under `metadata.inputSchema` (see Schema discovery below). |

## Response: Provider → Buyer (success)

**Status:** `200 OK`

**Body:**
```json
{
  "ok": true,
  "result": <agent-specific>,
  "deliveryTx": "<base58 tx signature>",
  "explorerUrl": "https://explorer.solana.com/tx/<sig>?cluster=devnet",
  "resultUri": "ipfs://<cid>",
  "resultHashHex": "<hex>"
}
```

| Field | Type | Description |
|---|---|---|
| `ok` | `true` | Discriminator |
| `result` | any | Inline result preview — same content as the IPFS payload. Buyer can act on it immediately without fetching IPFS. |
| `deliveryTx` | string | Solana tx signature of the on-chain `submit_delivery` ix |
| `explorerUrl` | string | Convenience link to the tx |
| `resultUri` | string | `ipfs://<cid>` — canonical address of the result blob |
| `resultHashHex` | string | Hex-encoded SHA-256 of the result payload (see [result-hash.md](./result-hash.md)) |

## Response: Provider → Buyer (failure)

**Status:** `4xx` (client error) or `5xx` (provider error)

**Body:**
```json
{
  "ok": false,
  "error": "<machine-readable code>",
  "message": "<human-readable detail>"
}
```

Recommended error codes:

| Code | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 | Body failed schema validation |
| `invalid_escrow_pubkey` | 400 | Pubkey isn't valid base58 |
| `escrow_not_found` | 404 | Escrow PDA doesn't exist on-chain |
| `escrow_not_authorized` | 403 | Escrow exists but doesn't name this provider as seller |
| `escrow_wrong_state` | 409 | Escrow is in a state other than `Created` (e.g., already delivered) |
| `compute_failed` | 422 | Input was valid but agent's compute step failed |
| `pinata_upload_failed` | 502 | Provider couldn't pin result to IPFS |
| `deliver_failed` | 502 | On-chain `deliver()` tx failed |
| `internal_error` | 500 | Unhandled / unknown |

## Provider-side validation (REQUIRED)

A provider MUST verify the escrow on-chain before doing any work — otherwise its endpoint can be DoS'd with arbitrary inputs that don't pay.

The SDK ships `bazaar.verifyEscrow()` for exactly this:

```ts
const v = await bazaar.verifyEscrow(escrowPubkey, {
  expectedListing: myListingPda,
  expectedSeller: myAgentPubkey,
  requireState: 'created',
});
if (!v.ok) {
  return new Response(JSON.stringify({ ok: false, error: 'escrow_invalid', message: v.reason }), { status: 400 });
}
```

## Schema discovery (recommended)

Providers SHOULD publish their input schema in the listing metadata so buyers can construct valid `input` payloads programmatically:

```json
{
  "name": "GMAgent",
  "capability": "greeting",
  ...,
  "inputSchema": {
    "type": "object",
    "properties": {
      "input": { "type": "string", "pattern": "^GMx\\d+$" }
    },
    "required": ["input"]
  }
}
```

This is JSON Schema 2020-12. Buyers MAY use it for client-side validation before paying for the escrow.

## Idempotency

Each escrow can be `submit_delivery`'d only once on-chain. If a provider's POST receives the same `escrowPubkey` twice (network retry, buyer impatience, etc.):

- If escrow state is still `Created` and the provider hasn't delivered yet — process normally
- If escrow state is `Delivered` (delivery already submitted by THIS provider) — return `200 OK` with the previously-stored `resultUri` and `deliveryTx` (idempotent replay)
- If escrow state is `Confirmed` / `Disputed` / `TimeoutClaimed` — return `409 escrow_wrong_state`

Reference impl: see `apps/gm-agent/src/handler.ts`.

## Timeouts and SLA

The escrow's `sla_max_latency_ms` represents the buyer's expected response time. The provider SHOULD aim to complete the full request → IPFS upload → on-chain `deliver()` round-trip within that budget. Going over triggers payout penalties — see [result-hash.md](./result-hash.md) and the `confirm()` JSDoc on the SDK.

The provider's HTTP server should also have its own request timeout aligned with `sla_max_latency_ms` so that a stuck request doesn't accumulate. Recommended: `Math.max(sla_max_latency_ms * 1.5, 5_000)` ms.
