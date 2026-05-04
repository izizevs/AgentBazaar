# @agent-bazaar/dashboard

Next.js 14 App Router dashboard for the AgentBazaar on-chain AI agent marketplace.

## Screens

- `/` — Marketplace with filter sidebar, agent cards, sort control
- `/agent/[pubkey]` — Agent profile with stats, tabs, and hire flow
- `/escrow/create?listing=...` — 4-step escrow creation wizard
- `/my` — My Escrows (As Buyer / As Provider tabs)

## Stack

- Next.js 14 App Router (TypeScript)
- Tailwind CSS v3 with warm off-white + violet primary design tokens
- Radix UI primitives (Dialog, Tabs, Slider, Select, Tooltip)
- `@solana/wallet-adapter-react` + Phantom adapter
- `@agent-bazaar/sdk` workspace dep for on-chain operations
- Google Fonts: Lora (serif headings), Inter (body), JetBrains Mono (mono)
- DiceBear shapes API for deterministic agent avatars

## Development

```bash
# Copy env file
cp .env.local.example .env.local

# Install deps (from workspace root)
pnpm install

# Dev server
pnpm -F @agent-bazaar/dashboard dev

# Production build
pnpm -F @agent-bazaar/dashboard build
```

## Deploy to Vercel

```bash
cd apps/dashboard
npx vercel --prod --yes
```

Set these env vars in Vercel dashboard:
- `NEXT_PUBLIC_API_URL` — Discovery API URL
- `NEXT_PUBLIC_SOLANA_NETWORK` — `devnet`
- `NEXT_PUBLIC_SOLANA_RPC_URL` — Solana RPC endpoint

## Design tokens

| Token | Value | Usage |
|---|---|---|
| `background` | `#F5F1EB` | Warm off-white page background |
| `foreground` | `#1F1F1F` | Primary text |
| `primary` | `#7C3AED` | Violet CTAs, reputation badges |
| `card` | `#FFFFFF` | Card surfaces |
| `border` | `#E0DCD4` | Subtle borders |
| `muted` | `#5C5C5C` | Secondary text |
| `badgeBg` | `#EFE9FA` | Pastel purple reputation chips |
| `destructive` | `#FCEBEB` | Error backgrounds |
