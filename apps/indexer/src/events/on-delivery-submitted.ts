import { getSql } from '../db/client.js';
import { logger } from '../logger.js';
import { safeLogUrl } from '../util/safe-log-url.js';
import type { DeliverySubmittedData } from './escrow-decoder.js';

export async function onDeliverySubmitted(
  txSignature: string,
  data: DeliverySubmittedData,
): Promise<void> {
  const escrowPubkey = data.escrow.toString();
  const resultUri = data.resultUri;
  const resultHash = Buffer.from(data.resultHash);
  const updatedAt = new Date(Number(data.deliveredAt.toString()) * 1000);

  const sql = getSql();

  await sql`
    UPDATE escrows
    SET result_uri  = ${resultUri},
        result_hash = ${resultHash},
        state       = 'delivered',
        updated_at  = ${updatedAt}
    WHERE pubkey = ${escrowPubkey}
  `;

  logger.info(
    { txSignature, escrowPubkey, resultUri: safeLogUrl(resultUri) },
    'DeliverySubmitted — updated',
  );
}
