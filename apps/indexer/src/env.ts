// Side-effect import: runs dotenvLoad() when this module is first evaluated,
// before any importer's top-level code. Must be the first import in the
// dependency graph so downstream modules (logger, db) read the populated env.
import 'dotenv-mono/load';

import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  HELIUS_API_KEY: z.string().min(1).optional(),
  // Required: indexer rejects all webhook requests when missing (fails closed).
  // min(32) ensures the secret has meaningful entropy before startup.
  HELIUS_WEBHOOK_SECRET: z.string().min(32),
  // Optional Pinata IPFS gateway (e.g. https://your-subdomain.mypinata.cloud/ipfs).
  // Falls back to https://ipfs.io/ipfs when unset.
  PINATA_GATEWAY: z.string().url().optional(),
  // TTL retention cron interval in milliseconds.
  // Defaults to 86 400 000 (24 h). Set to 0 to disable cron (useful in tests).
  RETENTION_INTERVAL_MS: z.coerce.number().int().min(0).default(86_400_000),
});

type Env = z.infer<typeof EnvSchema>;
let _env: Env | undefined;

// Lazy: parse is deferred until first call so tests that don't need DATABASE_URL
// can import from app.ts without a Zod throw at module-init time.
export function getEnv(): Env {
  if (!_env) _env = EnvSchema.parse(process.env);
  return _env;
}
