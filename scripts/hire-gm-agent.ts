/**
 * Hire the GM Agent using the master wallet.
 *
 * Flow: discover → pick GMAgent → hire (creates escrow, locks 0.10 USDC).
 * Output saved to /tmp/gm-escrow.json for the next phase to consume.
 *
 * Run: pnpm tsx scripts/hire-gm-agent.ts
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Connection, Keypair, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import { AgentBazaar } from '@agentbazaar/sdk';

function loadMaster(): Keypair {
  const arr = JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8')) as number[];
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
  if (!heliusKey) throw new Error('HELIUS_API_KEY not set');

  const rpc = `https://devnet.helius-rpc.com/?api-key=${heliusKey}`;
  const conn = new Connection(rpc, 'confirmed');
  const buyer = loadMaster();
  const wallet = makeWallet(buyer);
  const bazaar = new AgentBazaar({
    rpc: conn,
    wallet,
    discoveryApiUrl: 'https://agentbazaar-api.r-443.workers.dev',
  });

  console.log(`Buyer: ${buyer.publicKey.toBase58()}\n`);

  console.log('Discovering greeting agents...');
  const agents = await bazaar.discover({ capability: 'greeting', limit: 10 });
  if (agents.length === 0) throw new Error('No greeting agents found');

  const gm = agents.find((a) => a.endpoint?.includes('agentbazaar-gm-agent'));
  if (!gm) throw new Error('GMAgent not found among greeting agents');
  console.log(`✓ Found GMAgent`);
  console.log(`  listing:  ${gm.listing.toBase58()}`);
  console.log(`  endpoint: ${gm.endpoint}`);
  console.log(`  price:    ${Number(gm.priceUsdc) / 1_000_000} USDC\n`);

  console.log('Hiring (creating escrow + locking USDC)...');
  const handle = await bazaar.hire(gm.listing.toBase58(), {
    budget: gm.priceUsdc,
    sla: { maxLatencyMs: 30_000, minUptimePct: 99_00, responseFormat: 'json' },
    timeout: 600,
  });
  console.log(`✓ Escrow created`);
  console.log(`  escrow:   ${handle.escrowPda.toBase58()}`);
  console.log(`  vault:    ${handle.vaultPda.toBase58()}`);
  console.log(`  tx:       ${handle.signature}`);
  console.log(`  explorer: https://explorer.solana.com/tx/${handle.signature}?cluster=devnet\n`);

  const out = {
    escrowPubkey: handle.escrowPda.toBase58(),
    vaultPubkey: handle.vaultPda.toBase58(),
    listingPubkey: gm.listing.toBase58(),
    providerEndpoint: gm.endpoint,
    hireSignature: handle.signature,
    buyerPubkey: buyer.publicKey.toBase58(),
    budgetUsdcBaseUnits: gm.priceUsdc.toString(),
    createdAt: new Date().toISOString(),
  };
  writeFileSync('/tmp/gm-escrow.json', JSON.stringify(out, null, 2));
  console.log('Saved escrow handle to /tmp/gm-escrow.json');
  console.log('\nNext: POST work to the agent:');
  console.log(`  curl -X POST ${gm.endpoint}/process \\\n    -H 'Content-Type: application/json' \\\n    -d '{"escrowPubkey":"${handle.escrowPda.toBase58()}","input":"GMx3"}'`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
