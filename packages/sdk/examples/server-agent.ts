/**
 * server-agent.ts — minimal "long-running provider agent" template.
 *
 * Demonstrates the seller side of the AgentBazaar protocol:
 *   1. listen for HTTP POST /process from buyers
 *   2. verify the escrow on-chain belongs to this provider
 *   3. compute the result
 *   4. upload to IPFS
 *   5. sign + send bazaar.deliver()
 *   6. return result inline to the buyer
 *
 * Runtime: Node 22+ with Hono adapter. Uses the same pattern as the
 * GM-agent reference impl in apps/gm-agent (which targets Cloudflare
 * Workers). Swap the runtime by replacing the http server bootstrap;
 * the handler logic is identical.
 *
 * Run: tsx packages/sdk/examples/server-agent.ts
 *
 * Additional deps not bundled with the SDK (install in your own project):
 *   pnpm add hono @hono/node-server bs58 zod
 *
 * Required env:
 *   - PROVIDER_SECRET_KEY  base58 of 64-byte secretKey
 *   - PINATA_JWT           Pinata JWT for IPFS uploads
 *   - RPC_URL              Solana RPC (Helius devnet recommended)
 *   - PORT                 (optional, default 8080)
 *
 * Replace the body of `compute()` with your agent's actual work.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  Connection,
  Keypair,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import { AgentBazaar } from '../src/index.js';

// === Configuration ==========================================================

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const PINATA_JWT = required('PINATA_JWT');
const PROVIDER_SECRET_KEY = required('PROVIDER_SECRET_KEY');
const PORT = Number(process.env.PORT ?? 8080);

const provider = Keypair.fromSecretKey(bs58.decode(PROVIDER_SECRET_KEY));
const connection = new Connection(RPC_URL, 'confirmed');
const bazaar = new AgentBazaar({ wallet: makeWallet(provider), rpc: connection });

console.log(`Provider pubkey: ${provider.publicKey.toBase58()}`);

// === The actual work — replace with YOUR agent's logic ======================

function compute(input: string): string {
  // Example: GMx<n> → "GM" repeated n times.
  const m = input.trim().match(/^gm\s*x\s*(\d+)$/i);
  if (!m) throw new Error(`expected "GMx<n>" input, got "${input}"`);
  const n = Math.min(100, Math.max(1, Number.parseInt(m[1] ?? '0', 10)));
  return Array.from({ length: n }, () => 'GM').join(' ');
}

// === HTTP server ============================================================

const RequestSchema = z.object({
  escrowPubkey: z.string().min(32).max(64),
  input: z.string().min(1).max(256),
});

const app = new Hono();

app.get('/healthz', (c) =>
  c.json({ ok: true, pubkey: provider.publicKey.toBase58() }),
);

app.post('/process', async (c) => {
  // 1. Validate request shape
  const parsed = RequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { escrowPubkey, input } = parsed.data;

  // 2. Verify escrow on-chain — this is REQUIRED.
  // Without it, anyone can DoS the agent with arbitrary inputs.
  const v = await bazaar.verifyEscrow(escrowPubkey, {
    expectedSeller: provider.publicKey,
    requireState: 'created',
  });
  if (!v.ok) {
    return c.json({ ok: false, error: 'escrow_invalid', message: v.reason }, 400);
  }

  // 3. Compute the result
  let output: string;
  try {
    output = compute(input);
  } catch (err) {
    return c.json({ ok: false, error: 'compute_failed', message: (err as Error).message }, 422);
  }

  // 4. Build canonical payload, hash it, upload to IPFS
  const payload = JSON.stringify({
    input,
    output,
    computedAt: new Date().toISOString(),
    providerPubkey: provider.publicKey.toBase58(),
  });
  const resultHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)),
  );
  const cid = await uploadToPinata(payload);
  const resultUri = `ipfs://${cid}`;

  // 5. Sign + send the on-chain delivery (SDK handles ATA auto-create)
  let deliveryTx: string;
  try {
    deliveryTx = await bazaar.deliver(escrowPubkey, { resultUri, resultHash });
  } catch (err) {
    return c.json({ ok: false, error: 'deliver_failed', message: (err as Error).message }, 502);
  }

  // 6. Return result inline so the buyer doesn't need to fetch IPFS
  return c.json({
    ok: true,
    result: output,
    deliveryTx,
    explorerUrl: `https://explorer.solana.com/tx/${deliveryTx}?cluster=devnet`,
    resultUri,
    resultHashHex: toHex(resultHash),
  });
});

serve({ fetch: app.fetch, port: PORT });
console.log(`Listening on http://localhost:${PORT}`);

// === Helpers ================================================================

async function uploadToPinata(payload: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([payload], { type: 'application/json' }), 'result.json');
  form.append('network', 'public');
  const res = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Pinata upload failed: ${res.status}`);
  const json = (await res.json()) as { data: { cid: string } };
  return json.data.cid;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
