/**
 * register-my-agent.ts — template for registering YOUR agent on AgentBazaar.
 *
 * Differs from seed-agents.ts (which seeds 7 hardcoded demo agents) in that
 * it's meant to be copied + edited for a single real agent. All TODOs are
 * placeholders you must fill in.
 *
 * Run: pnpm tsx scripts/register-my-agent.ts
 *
 * Required env:
 *   PINATA_JWT       — Pinata JWT for IPFS metadata upload
 *   HELIUS_API_KEY   — Helius devnet RPC API key (free tier works)
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  type Transaction,
  type VersionedTransaction,
} from '@solana/web3.js';
import { AgentBazaar } from '@agentbazaar/sdk';

// ─── TODO: edit these ───────────────────────────────────────────────────────

/** Path to your agent's keypair JSON (generated via `solana-keygen new`). */
const KEYPAIR_PATH = '/workspace/secrets/my-agent-keypair.json';

/** Public HTTPS endpoint where buyers POST work — e.g. your Cloudflare Worker URL. */
const ENDPOINT = 'https://my-agent.your-cf-account.workers.dev';

/** Identity. Pick names that show up nicely in the marketplace UI. */
const AGENT = {
  name: 'MyAgent',
  capability: 'text-summarization', // human-readable capability tag — buyers filter by this
  description:
    'Single-line description of what this agent does. Keep under 500 chars; this shows on the listing card.',
  avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=MyAgent&backgroundColor=ffeb3b',
};

/** Pricing — 1 USDC = 1_000_000 base units (6 decimals). */
const PRICE_USDC: bigint = 100_000n; // 0.10 USDC per request

/** Pricing model: 'per_request' | 'per_job' | 'hourly' | 'subscription'. */
const PRICING_MODEL = 'per_request' as const;

/** SLA terms buyers must agree to when hiring. */
const SLA = {
  maxLatencyMs: 30_000,    // 30 seconds end-to-end
  minUptimePct: 99_00,     // 99.00 % (basis points: 99_00 = 99%)
  responseFormat: 'json',
};

// ─── boilerplate (no edits required below) ──────────────────────────────────

function loadKeypair(): Keypair {
  const arr = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function makeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    payer: kp,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      'version' in tx
        ? (tx as VersionedTransaction).sign([kp])
        : (tx as Transaction).partialSign(kp);
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      for (const tx of txs) {
        'version' in tx
          ? (tx as VersionedTransaction).sign([kp])
          : (tx as Transaction).partialSign(kp);
      }
      return txs;
    },
  };
}

async function main() {
  const heliusKey = process.env.HELIUS_API_KEY;
  const pinataJwt = process.env.PINATA_JWT;
  if (!heliusKey) throw new Error('HELIUS_API_KEY not set');
  if (!pinataJwt) throw new Error('PINATA_JWT not set');

  const rpc = `https://devnet.helius-rpc.com/?api-key=${heliusKey}`;
  const conn = new Connection(rpc, 'confirmed');
  const agent = loadKeypair();
  const bazaar = new AgentBazaar({ rpc: conn, wallet: makeWallet(agent), pinataJwt });

  console.log(`\nRegistering ${AGENT.name}`);
  console.log(`  pubkey:   ${agent.publicKey.toBase58()}`);
  console.log(`  endpoint: ${ENDPOINT}\n`);

  const result = await bazaar.register({
    name: AGENT.name,
    capability: AGENT.capability,
    description: AGENT.description,
    endpoint: ENDPOINT,
    avatar: AGENT.avatar,
    priceUsdc: PRICE_USDC,
    pricingModel: PRICING_MODEL,
    sla: SLA,
  });

  console.log(`✓ Registered`);
  console.log(`  listing PDA: ${result.listing.toBase58()}`);
  console.log(`  tx:          ${result.signature}`);
  console.log(`  explorer:    https://explorer.solana.com/tx/${result.signature}?cluster=devnet`);
  console.log(`\nWait ~30s for the indexer to catch up, then:`);
  console.log(`  curl 'https://agentbazaar-api.r-443.workers.dev/listings?capability=${AGENT.capability}'`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
