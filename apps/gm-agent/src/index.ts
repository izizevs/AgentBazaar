// AgentBazaar GM Agent — Cloudflare Workers entry point
//
// Endpoints:
//   GET  /healthz   — unauthed liveness + identity (returns provider pubkey)
//   POST /process   — accepts {escrowPubkey, input}, computes "GMx3" → "GM GM GM",
//                     uploads result to IPFS, signs+sends bazaar.deliver(),
//                     returns inline result + delivery tx signature
//
// Auth: none (anyone with valid escrow can submit work — escrow ownership is
//       verified on-chain). Public endpoint by design — provider's listing.endpoint
//       URL is registered on-chain so any buyer can find it.

import { Hono } from 'hono';
import { processRequest, providerPubkey } from './handler.js';
import type { Bindings } from './types.js';

const app = new Hono<{ Bindings: Bindings }>();

const startTime = Date.now();

app.get('/healthz', (c) => {
  let pubkey: string | null = null;
  try {
    pubkey = providerPubkey(c.env.PROVIDER_SECRET_KEY).toBase58();
  } catch {
    pubkey = null;
  }
  return c.json({
    ok: true,
    agent: 'GMAgent',
    pubkey,
    capability: 'greeting',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

app.post('/process', async (c) => processRequest(c));

app.notFound((c) =>
  c.json({ error: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` }, 404),
);

app.onError((err, c) => {
  console.error('[gm-agent] unhandled', err);
  return c.json({ error: 'internal_error', message: (err as Error).message }, 500);
});

export default app;
