import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { AnchorWallet } from './client.js';
import {
  DeliveryNotSubmittedError,
  EscrowAlreadyConfirmedError,
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
import type { ConfirmInput } from './types.js';

export async function confirmDelivery(
  connection: Connection,
  wallet: AnchorWallet,
  escrowId: string,
  input: ConfirmInput,
  usdcMint: PublicKey = DEVNET_USDC_MINT,
): Promise<string> {
  if (input.score < 0 || input.score > 100 || !Number.isInteger(input.score)) {
    throw new ValidationError('score must be an integer in range 0–100');
  }

  let escrowPda: PublicKey;
  try {
    escrowPda = new PublicKey(escrowId);
  } catch {
    throw new EscrowNotFoundError(escrowId);
  }

  const program = makeEscrowProgram(connection, wallet);

  const escrow = await program.account.escrowAccount.fetchNullable(escrowPda);
  if (!escrow) throw new EscrowNotFoundError(escrowId);

  if ('created' in escrow.state) throw new DeliveryNotSubmittedError(escrowId);
  if ('confirmed' in escrow.state) throw new EscrowAlreadyConfirmedError(escrowId);
  if ('timeoutClaimed' in escrow.state || 'disputed' in escrow.state) {
    throw new EscrowAlreadyResolvedError(escrowId);
  }

  const sellerTokenAccount = getAssociatedTokenAddress(usdcMint, escrow.seller as PublicKey);
  const buyerTokenAccount = getAssociatedTokenAddress(usdcMint, wallet.publicKey);

  const acctsTmp = {
    escrow: escrowPda,
    sellerTokenAccount,
    buyerTokenAccount,
    listing: escrow.listing as PublicKey,
  };
  // biome-ignore lint/suspicious/noExplicitAny: escrow PDA has self-referential seeds; Anchor TS cannot statically resolve it — must be passed explicitly
  const accts = acctsTmp as any;
  const ix = await program.methods
    .confirmDelivery(input.score, input.tags ?? [])
    .accounts(accts)
    .instruction();

  return sendWithRetry(connection, wallet, ix);
}
