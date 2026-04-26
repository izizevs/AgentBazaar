// Rate limiting middleware — lazy-initialized per-isolate.
//
// CF Workers disallows setInterval/setTimeout in the global scope (error 10021).
// hono-rate-limiter's MemoryStore sets up a cleanup interval at construction time,
// so we must NOT call rateLimiter() at module load — we must call it inside the
// first request handler. We use Hono's middleware signature to defer construction.
//
// Two tiers:
//   - Anonymous / IP-based:   100 req/min  (keyed by CF-Connecting-IP)
//   - Agent-identified:       1000 req/min (keyed by X-Agent-Pubkey header)
//
// MemoryStore is per-isolate; CF Workers may run multiple isolates across PoPs,
// so limits are best-effort. For hard global limits: CF native Rate Limiting
// binding (paid plan) or Upstash Redis.
import type { Context, MiddlewareHandler, Next } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';

type RateLimiterMiddleware = MiddlewareHandler;

// Module-level singleton: set on first request, never in the global init phase.
let _limiter: RateLimiterMiddleware | undefined;

function getKeyAndLimit(c: Context): { key: string; limit: number } {
  const agentPubkey = c.req.header('x-agent-pubkey');
  if (agentPubkey) {
    return { key: `agent:${agentPubkey}`, limit: 1000 };
  }
  const ip =
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  return { key: `ip:${ip}`, limit: 100 };
}

export function rateLimitMiddleware(c: Context, next: Next): Promise<Response | void> {
  if (!_limiter) {
    // Constructed inside the first request — safe for CF Workers global scope rules.
    _limiter = rateLimiter({
      windowMs: 60_000, // 1 minute
      limit: (ctx) => getKeyAndLimit(ctx).limit,
      keyGenerator: (ctx) => getKeyAndLimit(ctx).key,
      standardHeaders: 'draft-7',
      skip: (ctx) => ctx.req.path === '/healthz',
      handler: (ctx) => {
        return ctx.json(
          {
            error: 'rate_limit_exceeded',
            message: 'Too many requests. Retry after the window resets.',
          },
          429,
        );
      },
    });
  }
  return _limiter(c, next);
}
