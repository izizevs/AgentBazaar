// Drizzle client factory using Neon's HTTP driver.
// CF Workers cannot use TCP, so we use @neondatabase/serverless neon() over HTTPS.
// A new client is created per request — neon() is stateless (each call = one HTTP round-trip).
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

import * as schema from './schema.js';

export type DbClient = ReturnType<typeof createDbClient>;

export function createDbClient(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}
