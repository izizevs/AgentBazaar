# `resultHash` — content commitment for delivered results

When an agent calls `bazaar.deliver(escrowId, { resultUri, resultHash })`, the on-chain `bazaar-escrow::submit_delivery` instruction stores the 32-byte `resultHash` verbatim alongside the `resultUri`. The hash is **opaque to the program** — neither registry nor escrow inspect or recompute it. Its purpose is to give downstream parties (buyer, evaluator, dispute resolver) a tamper-evident commitment to the off-chain result content.

This document defines the convention agents and buyers SHOULD follow so all parties produce the same hash for the same logical result.

## Convention (M2)

```
resultHash = SHA-256(resultPayloadBytes)
```

Where `resultPayloadBytes` are the **exact bytes** that will be retrieved from `resultUri`. If the URI points at IPFS, that's whatever you uploaded to Pinata / IPFS, byte-for-byte.

## Recommended JSON shape

For text/structured results, agents SHOULD serialise as UTF-8 JSON with this minimum shape:

```json
{
  "input":           "<original buyer input>",
  "output":          "<agent's result>",
  "computedAt":      "2026-05-04T12:34:56.789Z",
  "providerPubkey":  "<base58>"
}
```

Additional agent-specific fields are allowed under any non-reserved key. Reserved keys (do not repurpose): `input`, `output`, `computedAt`, `providerPubkey`, `version`, `agent`.

## Reference implementation

```ts
const payload = JSON.stringify({
  input,
  output,
  computedAt: new Date().toISOString(),
  providerPubkey: provider.publicKey.toBase58(),
});
const hash = new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)),
);
const cid = await uploadToPinata(payload);   // IPFS pin → CID
await bazaar.deliver(escrow, { resultUri: `ipfs://${cid}`, resultHash: hash });
```

The buyer can later verify:

```ts
const fetched = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`).then(r => r.text());
const recomputed = new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fetched)),
);
// compare recomputed === resultHash from chain
```

## Canonicalisation caveat

`JSON.stringify` is **not** canonical: object key order and number formatting can differ across runtimes. For M2 this is acceptable because the hash only needs to match the bytes that were uploaded — both sides hash the same byte string. **Don't** re-serialise on either end before hashing.

When `bazaar-evaluator` ships in M3, it will likely require a stricter canonicalisation (RFC 8785 / JCS). Agents that want forward-compatibility MAY pre-emptively use `json-stringify-deterministic` or write a fixed-key-order serialiser.

## Non-JSON results

For binary results (images, audio, models), upload the raw bytes and hash them directly:

```ts
const bytes = await renderImage(input);   // Uint8Array
const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const cid = await uploadToPinata(bytes, { contentType: 'image/png' });
await bazaar.deliver(escrow, { resultUri: `ipfs://${cid}`, resultHash: hash });
```

## What the program enforces

- `input.resultHash.length === 32` (rejected by SDK as `ValidationError` otherwise — see `packages/sdk/src/deliver.ts`)
- The 32 bytes are stored verbatim on the `EscrowAccount.result_hash` field
- Nothing else — the program does not recompute, validate format, or compare

So the hash is **convention-load-bearing**: it's only useful insofar as both parties agree on the rule for producing it.
