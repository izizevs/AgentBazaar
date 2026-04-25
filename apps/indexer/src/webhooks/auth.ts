import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';

// Helius sends the authHeader value verbatim as the Authorization header on
// every webhook delivery. We read the expected secret directly from process.env
// at request time (not via getEnv()) so auth tests can set it without needing
// DATABASE_URL — keeping the DB-less CI test path intact.
export function verifyHeliusAuth(c: Context): boolean {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) return false;

  const received = c.req.header('Authorization') ?? '';
  if (!received) return false;

  const a = Buffer.from(secret);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
