import { getSql } from '../db/client.js';
import type { SlaParams } from '../db/schema.js';
import { logger } from '../logger.js';
import type { ServiceListingCreatedData } from './decoder.js';
import { fetchMetadata } from './fetch-metadata.js';

// Default SlaParams when the event doesn't carry SLA data (it's in the
// instruction args, not the emitted event). Indexer will track future
// SLA-update events; for now this placeholder satisfies the NOT NULL constraint.
const DEFAULT_SLA: SlaParams = {
  maxLatencyMs: null,
  minUptimePct: null,
  responseFormat: null,
  jsonSchemaUri: null,
  customParams: [],
};

export async function onListingCreated(
  txSignature: string,
  data: ServiceListingCreatedData,
): Promise<void> {
  const pubkey = data.listing.toString();
  const owner = data.owner.toString();
  const capabilityHash = Buffer.from(data.capabilityHash);
  const satiAgentId = BigInt(data.satiAgentId.toString());
  const priceUsdcBaseUnits = BigInt(data.priceUsdcBaseUnits.toString());
  const pricingModel = data.pricingModel;
  const metadataUri = data.metadataUri;
  const createdAt = new Date(Number(data.createdAt.toString()) * 1000);

  const sql = getSql();
  // postgres.js doesn't accept bigint in template literals — pass as strings;
  // Postgres parses them for the int8 (bigint) columns.
  const satiAgentIdStr = satiAgentId.toString();
  const priceUsdcBaseUnitsStr = priceUsdcBaseUnits.toString();

  // Upsert — ON CONFLICT DO NOTHING so a re-delivered event doesn't clobber
  // a listing that was subsequently updated.
  await sql`
    INSERT INTO service_listings (
      pubkey, owner, capability_hash, sati_agent_id, price_lamports,
      pricing_model, sla_params, metadata_uri, is_active, jobs_completed,
      created_at, updated_at
    ) VALUES (
      ${pubkey}, ${owner}, ${capabilityHash}, ${satiAgentIdStr}, ${priceUsdcBaseUnitsStr},
      ${pricingModel}, ${JSON.stringify(DEFAULT_SLA)}, ${metadataUri},
      true, 0, ${createdAt}, ${createdAt}
    )
    ON CONFLICT (pubkey) DO NOTHING
  `;

  // Best-effort IPFS metadata fetch to populate capability + endpoint.
  // Failure leaves columns null; they can be backfilled later.
  const metadata = await fetchMetadata(metadataUri);
  if (metadata) {
    await sql`
      UPDATE service_listings
      SET capability = ${metadata.capability},
          endpoint   = ${metadata.endpoint},
          updated_at = now()
      WHERE pubkey = ${pubkey}
    `;
  }

  logger.info(
    { txSignature, pubkey, owner, capability: metadata?.capability ?? null },
    'ServiceListingCreated — upserted',
  );
}
