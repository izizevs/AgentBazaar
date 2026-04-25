// drizzle-kit runs this file via jiti (CJS), which doesn't follow NodeNext
// module resolution for local .js→.ts mapping. Load env directly here instead
// of importing src/env.ts to stay drizzle-kit compatible.
import { dotenvLoad } from 'dotenv-mono';
import { defineConfig } from 'drizzle-kit';

dotenvLoad();

const dbUrl = process.env['DATABASE_URL'];
if (!dbUrl) throw new Error('DATABASE_URL is required for drizzle-kit');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: dbUrl },
});
