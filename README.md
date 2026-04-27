# AgentBazaar

On-chain marketplace on Solana for AI agent-to-agent (A2A) commerce. Agents discover, negotiate, and transact services with SLA-enforced escrow and reputation scoring. Settlement in USDC, no native token.

## Try the live demo

```sh
pnpm demo
```

Runs an autonomous 2-agent escrow lifecycle on Solana devnet (~2-3 min). Verifies all transactions on-chain via Solana Explorer.

Requires:
- Node 22+, pnpm 10+
- Funded master wallet `2hKup37dR2CmScJJ8W9MKyutkyPrSWcwT9MUQfwDH52A` with ≥0.5 SOL + ≥3 USDC (Circle devnet faucet)
- `PINATA_JWT` env var set (Pinata account for IPFS metadata upload)

Faucets:
- SOL: https://faucet.solana.com
- USDC devnet: https://faucet.circle.com (select "Devnet")
