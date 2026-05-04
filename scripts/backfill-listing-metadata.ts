/**
 * backfill-listing-metadata.ts
 *
 * Fetches IPFS metadata for any service_listings row where capability/endpoint/
 * metadata are still NULL despite metadata_uri being set. This handles cases
 * where the indexer's in-handler retry didn't succeed (Pinata propagation
 * window > 35 s, or temporary IPFS gateway outage).
 *
 * Idempotent — only updates rows that are still missing data.
 *
 * Run:    pnpm tsx scripts/backfill-listing-metadata.ts
 * Cron:   schedule daily; cheap (1 query + N IPFS fetches).
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fetchMetadataWithRetry } from '../apps/indexer/src/events/fetch-metadata.js';

interface Row {
  pubkey: string;
  metadata_uri: string;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');

  const psqlExec = (sql: string): string =>
    execFileSync('psql', [dbUrl, '-tAc', sql], { encoding: 'utf8' }).trim();

  const rows = psqlExec(`
    SELECT pubkey, metadata_uri
    FROM service_listings
    WHERE metadata IS NULL
      AND metadata_uri IS NOT NULL
      AND metadata_uri <> ''
    ORDER BY created_at ASC
  `);

  if (!rows) {
    console.log('No listings need backfill.');
    return;
  }

  const parsed: Row[] = rows
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pubkey, metadata_uri] = line.split('|');
      if (!pubkey || !metadata_uri) throw new Error(`Malformed psql row: ${line}`);
      return { pubkey, metadata_uri };
    });

  console.log(`Backfilling ${parsed.length} listings...`);

  let succeeded = 0;
  let failed = 0;

  for (const { pubkey, metadata_uri } of parsed) {
    const metadata = await fetchMetadataWithRetry(metadata_uri);
    if (!metadata) {
      console.log(`  ✗ ${pubkey.slice(0, 12)}... (still unreachable)`);
      failed++;
      continue;
    }

    const capLit = (metadata.capability ?? '').replace(/'/g, "''");
    const epLit = (metadata.endpoint ?? '').replace(/'/g, "''");
    const metaLit = JSON.stringify(metadata).replace(/'/g, "''");

    psqlExec(`
      UPDATE service_listings
      SET capability = '${capLit}',
          endpoint   = '${epLit}',
          metadata   = '${metaLit}'::jsonb,
          updated_at = now()
      WHERE pubkey = '${pubkey}'
    `);
    console.log(`  ✓ ${pubkey.slice(0, 12)}... → ${metadata.capability}`);
    succeeded++;
  }

  console.log(`\nBackfilled ${succeeded} / ${parsed.length} (${failed} still unreachable)`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
