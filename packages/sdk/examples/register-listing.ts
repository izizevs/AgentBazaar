/**
 * register-listing.ts — register an agent as a service provider on devnet.
 *
 * Prerequisites:
 *   - A funded devnet keypair at KEYPAIR_PATH (default: ~/.config/solana/id.json)
 *   - PINATA_JWT env var set
 *
 * Run:
 *   npx tsx examples/register-listing.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentBazaar,
  DuplicateListingError,
  MetadataUploadError,
  TransactionFailedError,
  ValidationError,
} from '@agent-bazaar/sdk';
import { Keypair } from '@solana/web3.js';

const DEVNET_RPC = 'https://api.devnet.solana.com';
const KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? path.join(os.homedir(), '.config/solana/id.json');
const PINATA_JWT = process.env.PINATA_JWT ?? '';

if (!PINATA_JWT) {
  console.error('PINATA_JWT env var is required');
  process.exit(1);
}

// Load a local Keypair and wrap it in the minimal AnchorWallet interface.
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8')));
const keypair = Keypair.fromSecretKey(secretKey);

const wallet = {
  publicKey: keypair.publicKey,
  signTransaction: async (tx: any) => {
    tx.sign(keypair);
    return tx;
  },
  signAllTransactions: async (txs: any[]) => {
    for (const tx of txs) tx.sign(keypair);
    return txs;
  },
};

const client = new AgentBazaar({
  wallet,
  rpc: DEVNET_RPC,
  pinataJwt: PINATA_JWT,
});

const result = await client
  .register({
    name: 'My Data Analysis Agent',
    description: 'Accepts CSV payloads and returns statistical summaries via JSON.',
    capability: 'data-analysis-v1',
    priceUsdc: 1_000_000n, // 1 USDC (6 decimals)
    pricingModel: 'per_request',
    sla: {
      maxLatencyMs: 5_000,
      minUptimePct: 9_500, // 95.00%
      responseFormat: 'json',
    },
    endpoint: 'https://my-agent.example.com/api',
  })
  .catch((err) => {
    if (err instanceof ValidationError) {
      console.error('Input validation failed:', err.message);
    } else if (err instanceof MetadataUploadError) {
      console.error('Metadata upload to Pinata failed:', err.message);
    } else if (err instanceof DuplicateListingError) {
      console.error('Active listing already exists for this capability:', err.message);
    } else if (err instanceof TransactionFailedError) {
      console.error('Transaction failed:', err.message);
      if (err.signature) console.error('Signature:', err.signature);
    } else {
      throw err;
    }
    process.exit(1);
  });

console.log('Registered listing:', result.listing.toBase58());
console.log('Transaction:', result.signature);
