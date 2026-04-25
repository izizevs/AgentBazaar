# Helius webhook setup — AgentBazaar indexer

The indexer receives on-chain events from Helius via an enhanced webhook.
Two program IDs are monitored: `bazaar-registry` and `bazaar-escrow`.

## Webhook details

| Field | Value |
|---|---|
| **Webhook ID** | `430f2432-ccf5-41cd-9d76-c836946c9efc` |
| **Type** | `enhanced` (devnet) |
| **Current URL** | `https://perdurable-spumescent-elvis.ngrok-free.dev/webhooks/helius` |
| **Programs monitored** | `ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3` (registry), `EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2` (escrow) |

The webhook was created via the Helius API. The URL points to the static ngrok
free domain associated with this Helius account. See **Smoke test** below to
activate the tunnel.

## Required env vars

```bash
# apps/indexer — required at startup (min 32 chars, must match Helius authHeader)
HELIUS_WEBHOOK_SECRET=Bearer def7d15435872bda824655bd3a299b4efac2d38ae96d363e3bb9477e0c53e948
HELIUS_WEBHOOK_ID=430f2432-ccf5-41cd-9d76-c836946c9efc
HELIUS_API_KEY=<your-key-from-dashboard.helius.dev>
```

`HELIUS_WEBHOOK_SECRET` is compared byte-for-byte (constant-time) against the
`Authorization` header Helius sends on every delivery. The value is the full
header string including the `Bearer ` prefix.

## Step 1 — Set authHeader in Helius dashboard

The Helius API does not expose `authHeader` in the create/update endpoints;
it must be set via the dashboard UI.

1. Go to [dashboard.helius.dev → Webhooks](https://dashboard.helius.dev/webhooks)
2. Click webhook `430f2432-ccf5-41cd-9d76-c836946c9efc`
3. Under **Auth Header**, paste the full value of `HELIUS_WEBHOOK_SECRET` from `.env`
4. Save

After this, every Helius delivery will include:
```
Authorization: Bearer def7d15435872bda824655bd3a299b4efac2d38ae96d363e3bb9477e0c53e948
```

## Step 2 — Start indexer locally

Inside the devcontainer:

```bash
cd apps/indexer
pnpm dev   # starts on port 3001
```

Verify it is listening:

```bash
curl http://localhost:3001/webhooks/helius   # should return 405 Method Not Allowed (POST only)
```

## Step 3 — Activate ngrok tunnel (smoke test)

The webhook URL uses the static ngrok free domain
`perdurable-spumescent-elvis.ngrok-free.dev`. Activate it by running:

```bash
# Requires ngrok installed + authenticated (https://dashboard.ngrok.com/get-started/setup)
ngrok http --domain=perdurable-spumescent-elvis.ngrok-free.dev 3001
```

Helius will now POST delivered events to the indexer.

> **Installing ngrok inside the devcontainer:**
> ```bash
> curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
> echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
> sudo apt update && sudo apt install ngrok
> ngrok config add-authtoken <YOUR_NGROK_TOKEN>
> ```

## Step 4 — Smoke test

With ngrok active and indexer running, submit a devnet transaction via the SDK:

```bash
# From the monorepo root — uses .env for SOLANA_CLUSTER + program IDs
npx tsx packages/sdk/examples/register.ts

# Watch indexer logs for event
# Expected log line (pino JSON):
# {"msg":"ServiceListingCreated — upserted","pubkey":"...","owner":"..."}

# Verify DB row
node -e "
const { dotenvLoad } = require('dotenv-mono');
dotenvLoad();
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);
sql\`SELECT pubkey, owner, created_at FROM service_listings ORDER BY created_at DESC LIMIT 3\`
  .then(r => { console.table(r); sql.end(); });
"
```

For escrow events, use the SDK `hire → deliver → confirm` flow described in
[`tests/e2e/`](../../../tests/e2e/).

## Updating the webhook URL (permanent deploy)

When the indexer is deployed to Railway or Fly, update the webhook URL via the
Helius API:

```bash
# Replace URL with deployed instance URL
curl -X PUT "https://api.helius.xyz/v0/webhooks/430f2432-ccf5-41cd-9d76-c836946c9efc?api-key=$HELIUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookURL": "https://YOUR-INDEXER-DOMAIN/webhooks/helius",
    "webhookType": "enhanced",
    "accountAddresses": [
      "ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3",
      "EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2"
    ],
    "transactionTypes": ["ANY"]
  }'
```

Or via the Helius dashboard: Webhooks → select `430f2432-ccf5...` → edit URL.

## Webhook payload format

Helius delivers an array of enhanced transaction objects. Each element has:

```jsonc
{
  "signature": "...",
  "slot": 123456,
  "timestamp": 1700000000,
  "instructions": [
    {
      "programId": "ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3",
      "data": "<base64>",
      "innerInstructions": [
        {
          "programId": "...", // same program (emit_cpi! self-CPI)
          "data": "<base64-encoded Anchor event>"
        }
      ]
    }
  ]
}
```

The indexer decodes Anchor events from `innerInstructions` using
`BorshEventCoder` and dispatches them to the appropriate handler.
Replay dedup is handled via the `processed_signatures` table
(`INSERT … ON CONFLICT DO NOTHING RETURNING`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Unauthorized` in indexer logs | `HELIUS_WEBHOOK_SECRET` in `.env` doesn't match the `authHeader` set in Helius dashboard |
| Events delivered but no DB rows | Check `DATABASE_URL` is set; run `pnpm db:migrate` |
| ngrok `ERR_NGROK_3200` | Domain not claimed — log in to ngrok dashboard and claim `perdurable-spumescent-elvis.ngrok-free.app` |
| No events after tx | Confirm the program ID is in the webhook's monitored addresses list |
