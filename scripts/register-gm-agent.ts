/**
 * Register the GM Agent on devnet.
 *
 * Run:
 *   pnpm tsx scripts/register-gm-agent.ts
 *
 * Requires:
 *   - secrets/gm-agent-keypair.json   (GM agent's funded keypair)
 *   - .env: HELIUS_API_KEY, PINATA_JWT
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import { AgentBazaar } from '@agentbazaar/sdk';

const KEYPAIR_PATH = '/workspace/secrets/gm-agent-keypair.json';
const WORKER_URL = 'https://agentbazaar-gm-agent.r-443.workers.dev';

function loadKeypair(): Keypair {
  const arr = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function makeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    payer: kp,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if ('version' in tx) (tx as VersionedTransaction).sign([kp]);
      else (tx as Transaction).partialSign(kp);
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      for (const tx of txs) {
        if ('version' in tx) (tx as VersionedTransaction).sign([kp]);
        else (tx as Transaction).partialSign(kp);
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
  const wallet = makeWallet(agent);
  const bazaar = new AgentBazaar({ rpc: conn, wallet, pinataJwt });

  console.log(`\nRegistering GMAgent`);
  console.log(`  pubkey:   ${agent.publicKey.toBase58()}`);
  console.log(`  endpoint: ${WORKER_URL}\n`);

  const result = await bazaar.register({
    name: 'GMAgent',
    capability: 'greeting',
    description: "Send 'GMx<n>' (e.g. 'GMx3') and receive 'GM' repeated n times. Trivial demo agent — first 3rd-party reference impl on AgentBazaar.",
    endpoint: WORKER_URL,
    avatar: 'https://api.dicebear.com/7.x/shapes/svg?seed=GMAgent&backgroundColor=ffeb3b',
    priceUsdc: 100_000n,
    pricingModel: 'per_request',
    sla: { maxLatencyMs: 30_000, minUptimePct: 9900, responseFormat: 'json' },
  });

  console.log(`✓ Registered`);
  console.log(`  listing PDA: ${result.listing.toBase58()}`);
  console.log(`  tx:          ${result.signature}`);
  console.log(`  explorer:    https://explorer.solana.com/tx/${result.signature}?cluster=devnet`);
  console.log(`\nWait ~30s for Helius webhook → indexer → DB, then check:`);
  console.log(`  curl 'https://agentbazaar-api.r-443.workers.dev/listings?capability=greeting'`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
