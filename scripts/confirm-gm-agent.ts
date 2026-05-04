/**
 * Confirm GM Agent delivery — releases USDC to the agent.
 *
 * Reads /tmp/gm-escrow.json (from hire-gm-agent.ts) and calls bazaar.confirm().
 *
 * Run: pnpm tsx scripts/confirm-gm-agent.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
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

  const handle = JSON.parse(readFileSync('/tmp/gm-escrow.json', 'utf8')) as {
    escrowPubkey: string;
    providerEndpoint: string;
  };

  const rpc = `https://devnet.helius-rpc.com/?api-key=${heliusKey}`;
  const conn = new Connection(rpc, 'confirmed');
  const buyer = loadMaster();
  const wallet = makeWallet(buyer);
  const bazaar = new AgentBazaar({
    rpc: conn,
    wallet,
    discoveryApiUrl: 'https://agentbazaar-api.r-443.workers.dev',
  });

  console.log(`Confirming escrow ${handle.escrowPubkey}`);
  const sig = await bazaar.confirm(handle.escrowPubkey, { score: 100 });
  console.log(`✓ Confirmed`);
  console.log(`  tx:       ${sig}`);
  console.log(`  explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log(`\nUSDC released to provider. Check:`);
  console.log(`  curl 'https://agentbazaar-api.r-443.workers.dev/escrows/${handle.escrowPubkey}'`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
