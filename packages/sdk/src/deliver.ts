import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import type { Connection, TransactionInstruction } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { AnchorWallet } from './client.js';
import {
  EscrowAlreadyDeliveredError,
  EscrowAlreadyResolvedError,
  EscrowNotFoundError,
  ValidationError,
} from './errors.js';
import {
  DEVNET_USDC_MINT,
  getAssociatedTokenAddress,
  makeEscrowProgram,
  sendWithRetry,
} from './escrow-utils.js';
import type { DeliverInput } from './types.js';

export async function deliverJob(
  connection: Connection,
  wallet: AnchorWallet,
  escrowId: string,
  input: DeliverInput,
  usdcMint: PublicKey = DEVNET_USDC_MINT,
): Promise<string> {
  if (!input.resultUri) throw new ValidationError('resultUri is required');
  if (input.resultHash.length !== 32) throw new ValidationError('resultHash must be 32 bytes');

  let escrowPda: PublicKey;
  try {
    escrowPda = new PublicKey(escrowId);
  } catch {
    throw new EscrowNotFoundError(escrowId);
  }

  const program = makeEscrowProgram(connection, wallet);

  const escrow = await program.account.escrowAccount.fetchNullable(escrowPda);
  if (!escrow) throw new EscrowNotFoundError(escrowId);

  if ('delivered' in escrow.state) throw new EscrowAlreadyDeliveredError(escrowId);
  if (
    'confirmed' in escrow.state ||
    'timeoutClaimed' in escrow.state ||
    'disputed' in escrow.state
  ) {
    throw new EscrowAlreadyResolvedError(escrowId);
  }

  const sellerTokenAccount = getAssociatedTokenAddress(usdcMint, wallet.publicKey);

  // biome-ignore lint/suspicious/noExplicitAny: escrow PDA has self-referential seeds; Anchor TS cannot statically resolve it — must be passed explicitly
  const accts = { escrow: escrowPda, sellerTokenAccount } as any;
  const deliverIx = await program.methods
    .submitDelivery(input.resultUri, Array.from(input.resultHash) as number[])
    .accounts(accts)
    .instruction();

  // The escrow program requires `seller_token_account` to be already initialized
  // (it transfers USDC into it during confirm/timeout-claim). For a fresh agent
  // the ATA doesn't exist yet, so the very first delivery would fail with
  // AccountNotInitialized. We prepend a create-idempotent ix so the seller pays
  // the ~0.002 SOL ATA rent once, atomically with the first delivery.
  const ixs: TransactionInstruction[] = [];
  const ataInfo = await connection.getAccountInfo(sellerTokenAccount);
  if (!ataInfo) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        sellerTokenAccount,
        wallet.publicKey,
        usdcMint,
      ),
    );
  }
  ixs.push(deliverIx);

  return sendWithRetry(connection, wallet, ixs);
}
