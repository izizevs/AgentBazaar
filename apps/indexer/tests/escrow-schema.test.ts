import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dbUrl = process.env.DATABASE_URL;

describe.skipIf(!dbUrl)('escrow schema migration', () => {
  const pg = postgres(dbUrl!);
  const db = drizzle(pg);

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: './drizzle' });
  });

  afterAll(async () => {
    await pg.end();
  });

  describe('escrows table', () => {
    it('table exists', async () => {
      const rows = await db.execute(
        sql`SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'escrows'`,
      );
      expect(rows.length).toBe(1);
    });

    it('has all required columns', async () => {
      const expected = [
        'pubkey',
        'buyer',
        'seller',
        'listing',
        'vault',
        'amount_usdc',
        'sla_params',
        'state',
        'result_uri',
        'result_hash',
        'deadline',
        'created_at',
        'updated_at',
      ];
      const rows = await db.execute(
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_name = 'escrows' ORDER BY ordinal_position`,
      );
      const names = rows.map((r) => (r as { column_name: string }).column_name);
      for (const col of expected) {
        expect(names, `missing column: ${col}`).toContain(col);
      }
    });

    it('result_hash is bytea', async () => {
      const rows = await db.execute(
        sql`SELECT data_type FROM information_schema.columns
            WHERE table_name = 'escrows' AND column_name = 'result_hash'`,
      );
      expect((rows[0] as { data_type: string }).data_type).toBe('bytea');
    });

    it('seller+state and buyer+state indexes exist', async () => {
      const rows = await db.execute(
        sql`SELECT indexname FROM pg_indexes WHERE tablename = 'escrows'`,
      );
      const names = rows.map((r) => (r as { indexname: string }).indexname);
      expect(names).toContain('idx_escrows_seller_state');
      expect(names).toContain('idx_escrows_buyer_state');
    });
  });

  describe('sla_reports table', () => {
    it('table exists', async () => {
      const rows = await db.execute(
        sql`SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'sla_reports'`,
      );
      expect(rows.length).toBe(1);
    });

    it('id column is bigint (bigserial)', async () => {
      const rows = await db.execute(
        sql`SELECT data_type FROM information_schema.columns
            WHERE table_name = 'sla_reports' AND column_name = 'id'`,
      );
      expect((rows[0] as { data_type: string }).data_type).toBe('bigint');
    });

    it('escrow_pubkey index exists', async () => {
      const rows = await db.execute(
        sql`SELECT indexname FROM pg_indexes WHERE tablename = 'sla_reports'`,
      );
      const names = rows.map((r) => (r as { indexname: string }).indexname);
      expect(names).toContain('idx_sla_reports_escrow_pubkey');
    });
  });

  describe('agent_reputation table', () => {
    it('table exists', async () => {
      const rows = await db.execute(
        sql`SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'agent_reputation'`,
      );
      expect(rows.length).toBe(1);
    });

    it('has all required columns', async () => {
      const expected = ['wallet', 'jobs_completed', 'avg_score', 'total_score', 'last_updated'];
      const rows = await db.execute(
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_name = 'agent_reputation' ORDER BY ordinal_position`,
      );
      const names = rows.map((r) => (r as { column_name: string }).column_name);
      for (const col of expected) {
        expect(names, `missing column: ${col}`).toContain(col);
      }
    });

    it('numeric defaults are 0', async () => {
      const rows = await db.execute(
        sql`SELECT column_name, column_default FROM information_schema.columns
            WHERE table_name = 'agent_reputation'
              AND column_name IN ('jobs_completed', 'avg_score', 'total_score')
            ORDER BY column_name`,
      );
      for (const row of rows as unknown as Array<{ column_name: string; column_default: string }>) {
        expect(row.column_default, `default for ${row.column_name}`).toMatch(/^0/);
      }
    });
  });
});
