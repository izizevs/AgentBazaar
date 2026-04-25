import { web3 } from '@coral-xyz/anchor';

import { getSql } from '../db/client.js';
import { logger } from '../logger.js';
import type { EscrowCreatedData } from './escrow-decoder.js';

const ESCROW_PROGRAM_ID = new web3.PublicKey('EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2');

// Vault PDA is deterministic: seeds = ["vault", escrowPubkey].
// The EscrowCreated event doesn't carry vault — derive it here.
function deriveVault(escrowKey: web3.PublicKey): string {
  const [vaultPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), escrowKey.toBytes()],
    ESCROW_PROGRAM_ID,
  );
  return vaultPda.toBase58();
}

export async function onEscrowCreated(txSignature: string, data: EscrowCreatedData): Promise<void> {
  const escrowPubkey = data.escrow.toString();
  const escrowKey = new web3.PublicKey(escrowPubkey);

  const buyer = data.buyer.toString();
  const seller = data.seller.toString();
  const listing = data.listing.toString();
  const vault = deriveVault(escrowKey);
  const amountUsdc = data.amount.toString();
  const deadline = new Date(Number(data.deadlineTs.toString()) * 1000);
  const createdAt = new Date(Number(data.createdAt.toString()) * 1000);

  const sql = getSql();

  // sla_params stores an empty object until a full account fetch fills it in.
  // The on-chain SLA fields are instruction args, not emitted in the event.
  await sql`
    INSERT INTO escrows (
      pubkey, buyer, seller, listing, vault, amount_usdc,
      sla_params, state, deadline, created_at, updated_at
    ) VALUES (
      ${escrowPubkey}, ${buyer}, ${seller}, ${listing}, ${vault}, ${amountUsdc},
      ${'{}'}::jsonb, ${'created'}, ${deadline}, ${createdAt}, ${createdAt}
    )
    ON CONFLICT (pubkey) DO NOTHING
  `;

  logger.info({ txSignature, escrowPubkey, buyer, seller, amountUsdc }, 'EscrowCreated — inserted');
}
