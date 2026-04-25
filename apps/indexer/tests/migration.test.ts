import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const EXPECTED_COLUMNS = [
  'pubkey',
  'owner',
  'capability_hash',
  'sati_agent_id',
  'price_lamports',
  'pricing_model',
  'sla_params',
  'metadata_uri',
  'is_active',
  'jobs_completed',
  'created_at',
  'updated_at',
] as const;

const EXPECTED_INDEXES = [
  'idx_service_listings_capability_hash',
  'idx_service_listings_discover',
] as const;

const dbUrl = process.env['DATABASE_URL'];

describe.skipIf(!dbUrl)('service_listings migration', () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by skipIf above
  const pg = postgres(dbUrl!);
  const db = drizzle(pg);

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: './drizzle' });
  });

  afterAll(async () => {
    await pg.end();
  });

  it('table exists', async () => {
    const rows = await db.execute(
      sql`
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'service_listings'
      `,
    );
    expect(rows.length).toBe(1);
  });

  it('all expected columns are present', async () => {
    const rows = await db.execute(
      sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'service_listings'
        ORDER BY ordinal_position
      `,
    );
    const names = rows.map((r) => (r as { column_name: string }).column_name);
    for (const col of EXPECTED_COLUMNS) {
      expect(names, `missing column: ${col}`).toContain(col);
    }
  });

  it('capability_hash column is bytea', async () => {
    const rows = await db.execute(
      sql`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_name = 'service_listings'
          AND column_name = 'capability_hash'
      `,
    );
    expect((rows[0] as { data_type: string }).data_type).toBe('bytea');
  });

  it('both discover indexes exist', async () => {
    const rows = await db.execute(
      sql`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'service_listings'
      `,
    );
    const names = rows.map((r) => (r as { indexname: string }).indexname);
    for (const idx of EXPECTED_INDEXES) {
      expect(names, `missing index: ${idx}`).toContain(idx);
    }
  });
});
