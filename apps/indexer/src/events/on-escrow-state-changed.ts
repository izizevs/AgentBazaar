import { getSql } from '../db/client.js';
import { logger } from '../logger.js';
import type { EscrowStateChangedData } from './escrow-decoder.js';
import { decodeEscrowState } from './escrow-decoder.js';

export async function onEscrowStateChanged(
  txSignature: string,
  data: EscrowStateChangedData,
): Promise<void> {
  const escrowPubkey = data.escrow.toString();
  const oldState = decodeEscrowState(data.oldState);
  const newState = decodeEscrowState(data.newState);
  const updatedAt = new Date(Number(data.timestamp.toString()) * 1000);

  const sql = getSql();

  await sql`
    UPDATE escrows
    SET state = ${newState}, updated_at = ${updatedAt}
    WHERE pubkey = ${escrowPubkey}
  `;

  logger.info({ txSignature, escrowPubkey, oldState, newState }, 'EscrowStateChanged — updated');
}
