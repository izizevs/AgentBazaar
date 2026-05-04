/**
 * Backfill indexer DB with ServiceListing accounts from chain.
 *
 * Use case: webhook was disabled for a period → events missed → DB out of sync.
 * This script reads all ServiceListing accounts via getProgramAccounts and
 * inserts/updates rows in Postgres. Idempotent (ON CONFLICT DO UPDATE).
 *
 * Run: pnpm tsx scripts/backfill-listings.ts
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { BazaarRegistryIDL } from '@agentbazaar/idl';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const DEVNET = process.env.HELIUS_API_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : 'https://api.devnet.solana.com';
const REGISTRY = 'ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const psqlExec = (sqlText: string): string =>
    execFileSync('psql', [dbUrl, '-tAc', sqlText], { encoding: 'utf8' }).trim();

  const conn = new Connection(DEVNET, 'confirmed');
  const dummyWallet = {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async (t: any) => t,
    signAllTransactions: async (ts: any) => ts,
  };
  const provider = new AnchorProvider(conn, dummyWallet as any, { commitment: 'confirmed' });
  // biome-ignore lint/suspicious/noExplicitAny: Anchor IDL typing
  const program = new Program(BazaarRegistryIDL as any, provider);

  console.log(`Fetching ServiceListing accounts from ${REGISTRY}...`);
  const all = await program.account.serviceListing.all();
  console.log(`Found ${all.length} listings on chain`);

  for (const { publicKey: pk, account } of all) {
    const a = account as any;
    const pubkey = pk.toBase58();
    const owner = a.owner.toBase58();
    const capabilityHash = Buffer.from(a.capabilityHash as number[]).toString('hex');
    const satiAgentId = a.satiAgentId.toString();
    const priceUsdcBaseUnits = a.priceUsdcBaseUnits.toString();
    const pricingModel = a.pricingModel;
    const slaParams = JSON.stringify({
      maxLatencyMs: a.slaParams.maxLatencyMs ?? null,
      minUptimePct: a.slaParams.minUptimePct ?? null,
      responseFormat: a.slaParams.responseFormat ?? null,
      jsonSchemaUri: a.slaParams.jsonSchemaUri ?? null,
      customParams: a.slaParams.customParams ?? [],
    });
    const metadataUri = a.metadataUri;
    const isActive = a.isActive;
    const jobsCompleted = a.jobsCompleted;
    const createdAt = new Date(Number(a.createdAt.toString()) * 1000);

    const slaParamsLit = slaParams.replace(/'/g, "''");
    const metadataUriLit = metadataUri.replace(/'/g, "''");
    const createdAtLit = createdAt.toISOString();
    const sqlText = `
      INSERT INTO service_listings (
        pubkey, owner, capability_hash, sati_agent_id, price_usdc_base_units,
        pricing_model, sla_params, metadata_uri, is_active, jobs_completed,
        created_at, updated_at
      ) VALUES (
        '${pubkey}', '${owner}', '${capabilityHash}', ${satiAgentId}, ${priceUsdcBaseUnits},
        ${pricingModel}, '${slaParamsLit}'::jsonb, '${metadataUriLit}', ${isActive}, ${jobsCompleted},
        '${createdAtLit}', '${createdAtLit}'
      )
      ON CONFLICT (pubkey) DO UPDATE SET
        price_usdc_base_units = EXCLUDED.price_usdc_base_units,
        metadata_uri = EXCLUDED.metadata_uri,
        is_active = EXCLUDED.is_active,
        jobs_completed = EXCLUDED.jobs_completed,
        updated_at = EXCLUDED.updated_at
    `;
    try {
      psqlExec(sqlText);
      console.log(`  ✓ ${pubkey.slice(0, 12)}... ${metadataUri.slice(0, 40)}`);
    } catch (err) {
      console.log(`  ✗ ${pubkey.slice(0, 12)}... ${(err as Error).message}`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
