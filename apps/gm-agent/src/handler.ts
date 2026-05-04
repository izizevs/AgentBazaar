import { AgentBazaar } from '@agentbazaar/sdk';
import {
  Connection,
  Keypair,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from './types.js';

const RequestSchema = z.object({
  escrowPubkey: z.string().min(32).max(64),
  input: z.string().min(1).max(256),
});

export function loadProvider(secretBase58: string): Keypair {
  const bytes = bs58.decode(secretBase58);
  if (bytes.length !== 64) {
    throw new Error(`Invalid PROVIDER_SECRET_KEY: expected 64 bytes, got ${bytes.length}`);
  }
  return Keypair.fromSecretKey(bytes);
}

export function providerPubkey(secretBase58: string): PublicKey {
  return loadProvider(secretBase58).publicKey;
}

function parseMultiplier(input: string): number {
  const match = input.trim().match(/^gm\s*x\s*(\d+)$/i);
  if (!match) {
    throw new Error(`Unsupported input "${input}". Expected format: "GMx<n>" (e.g., "GMx3")`);
  }
  const n = Number.parseInt(match[1] ?? '0', 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    throw new Error(`Multiplier must be 1..100, got ${n}`);
  }
  return n;
}

function compute(input: string): string {
  const n = parseMultiplier(input);
  return Array.from({ length: n }, () => 'GM').join(' ');
}

async function sha256(payload: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function uploadResult(payload: string, jwt: string): Promise<string> {
  const form = new FormData();
  const blob = new Blob([payload], { type: 'application/json' });
  form.append('file', blob, `gm-result-${Date.now()}.json`);
  form.append('network', 'public');

  const res = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pinata upload failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: { cid?: string } };
  const cid = json.data?.cid;
  if (!cid) throw new Error(`Pinata response missing cid: ${JSON.stringify(json).slice(0, 200)}`);
  return cid;
}

function makeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    payer: kp,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if ('version' in tx) {
        (tx as VersionedTransaction).sign([kp]);
      } else {
        (tx as Transaction).partialSign(kp);
      }
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> {
      for (const tx of txs) {
        if ('version' in tx) {
          (tx as VersionedTransaction).sign([kp]);
        } else {
          (tx as Transaction).partialSign(kp);
        }
      }
      return txs;
    },
  };
}

export async function processRequest(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json', message: 'Body must be valid JSON' }, 400);
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { escrowPubkey: escrowPubkeyStr, input } = parsed.data;

  let escrowPubkey: PublicKey;
  try {
    escrowPubkey = new PublicKey(escrowPubkeyStr);
  } catch {
    return c.json({ error: 'invalid_escrow_pubkey', message: 'Not a valid base58 pubkey' }, 400);
  }

  let provider: Keypair;
  try {
    provider = loadProvider(c.env.PROVIDER_SECRET_KEY);
  } catch (err) {
    return c.json({ error: 'provider_key_error', message: (err as Error).message }, 500);
  }

  const connection = new Connection(c.env.RPC_URL, 'confirmed');

  const escrowAccount = await connection.getAccountInfo(escrowPubkey);
  if (!escrowAccount) {
    return c.json(
      { error: 'escrow_not_found', message: `Escrow ${escrowPubkeyStr} not found on-chain` },
      404,
    );
  }

  let output: string;
  try {
    output = compute(input);
  } catch (err) {
    return c.json({ error: 'compute_failed', message: (err as Error).message }, 422);
  }

  const resultPayload = JSON.stringify({
    input,
    output,
    computedAt: new Date().toISOString(),
    providerPubkey: provider.publicKey.toBase58(),
    agent: 'GMAgent',
    version: 1,
  });

  const hashBytes = await sha256(resultPayload);

  let cid: string;
  try {
    cid = await uploadResult(resultPayload, c.env.PINATA_JWT);
  } catch (err) {
    return c.json({ error: 'pinata_upload_failed', message: (err as Error).message }, 502);
  }
  const resultUri = `ipfs://${cid}`;

  const wallet = makeWallet(provider);
  const bazaar = new AgentBazaar({ wallet, rpc: connection });

  let deliveryTx: string;
  try {
    deliveryTx = await bazaar.deliver(escrowPubkeyStr, {
      resultUri,
      resultHash: hashBytes,
    });
  } catch (err) {
    return c.json(
      {
        error: 'deliver_failed',
        message: (err as Error).message,
        resultUri,
        resultHashHex: toHex(hashBytes),
      },
      502,
    );
  }

  return c.json({
    ok: true,
    result: output,
    resultUri,
    resultHashHex: toHex(hashBytes),
    deliveryTx,
    explorerUrl: `https://explorer.solana.com/tx/${deliveryTx}?cluster=devnet`,
  });
}
