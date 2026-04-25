import { getSql } from '../db/client.js';
import { logger } from '../logger.js';
import { safeLogUrl } from '../util/safe-log-url.js';
import type { ServiceListingUpdatedData } from './decoder.js';
import { fetchMetadata } from './fetch-metadata.js';

export async function onListingUpdated(
  txSignature: string,
  data: ServiceListingUpdatedData,
): Promise<void> {
  const pubkey = data.listing.toString();
  const isActive = data.isActive;
  const updatedAt = new Date(Number(data.updatedAt.toString()) * 1000);
  // Pass price as string — postgres.js doesn't accept bigint in template literals.
  const newPrice = data.newPrice != null ? data.newPrice.toString() : null;
  const newUri = data.newUri ?? null;

  const sql = getSql();

  if (newPrice != null && newUri != null) {
    await sql`
      UPDATE service_listings
      SET price_lamports = ${newPrice},
          metadata_uri   = ${newUri},
          is_active      = ${isActive},
          updated_at     = ${updatedAt}
      WHERE pubkey = ${pubkey}
    `;
  } else if (newPrice != null) {
    await sql`
      UPDATE service_listings
      SET price_lamports = ${newPrice},
          is_active      = ${isActive},
          updated_at     = ${updatedAt}
      WHERE pubkey = ${pubkey}
    `;
  } else if (newUri != null) {
    await sql`
      UPDATE service_listings
      SET metadata_uri = ${newUri},
          is_active    = ${isActive},
          updated_at   = ${updatedAt}
      WHERE pubkey = ${pubkey}
    `;
  } else {
    await sql`
      UPDATE service_listings
      SET is_active  = ${isActive},
          updated_at = ${updatedAt}
      WHERE pubkey = ${pubkey}
    `;
  }

  // Re-fetch IPFS metadata when metadata_uri changed.
  if (newUri) {
    const metadata = await fetchMetadata(newUri);
    if (metadata) {
      await sql`
        UPDATE service_listings
        SET capability = ${metadata.capability},
            endpoint   = ${metadata.endpoint},
            updated_at = now()
        WHERE pubkey = ${pubkey}
      `;
    }
  }

  logger.info(
    {
      txSignature,
      pubkey,
      newPrice: newPrice?.toString() ?? null,
      newUri: newUri ? safeLogUrl(newUri) : null,
      isActive,
    },
    'ServiceListingUpdated — applied',
  );
}
