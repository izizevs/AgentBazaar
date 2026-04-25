import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { AnchorWallet } from './client.js';
import {
  EscrowAlreadyDisputedError,
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
import type { DisputeInput } from './types.js';

export async function openEscrowDispute(
  connection: Connection,
  wallet: AnchorWallet,
  escrowId: string,
  input: DisputeInput,
  usdcMint: PublicKey = DEVNET_USDC_MINT,
): Promise<string> {
  if (!input.reason || input.reason.trim().length === 0) {
    throw new ValidationError('reason is required');
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

  if ('disputed' in escrow.state) throw new EscrowAlreadyDisputedError(escrowId);
  if ('confirmed' in escrow.state || 'timeoutClaimed' in escrow.state) {
    throw new EscrowAlreadyResolvedError(escrowId);
  }

  const buyerTokenAccount = getAssociatedTokenAddress(usdcMint, wallet.publicKey);

  // biome-ignore lint/suspicious/noExplicitAny: escrow PDA has self-referential seeds; Anchor TS cannot statically resolve it — must be passed explicitly
  const accts = { escrow: escrowPda, buyerTokenAccount } as any;
  const ix = await program.methods
    .openDispute(input.reason, input.evidenceUri ?? '')
    .accounts(accts)
    .instruction();

  return sendWithRetry(connection, wallet, ix);
}
