import { getSql } from '../db/client.js';
import { logger } from '../logger.js';
import { safeLogUrl } from '../util/safe-log-url.js';
import type { DisputeOpenedData } from './escrow-decoder.js';

export async function onDisputeOpened(txSignature: string, data: DisputeOpenedData): Promise<void> {
  const escrowPubkey = data.escrow.toString();
  const openedAt = new Date(Number(data.openedAt.toString()) * 1000);

  const sql = getSql();

  await sql`
    UPDATE escrows
    SET state = 'disputed', updated_at = ${openedAt}
    WHERE pubkey = ${escrowPubkey}
  `;

  logger.info(
    {
      txSignature,
      escrowPubkey,
      buyer: data.buyer.toString(),
      evidenceUri: safeLogUrl(data.evidenceUri),
    },
    'DisputeOpened — updated',
  );
}
