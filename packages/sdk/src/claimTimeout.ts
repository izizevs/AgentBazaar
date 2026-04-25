import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { AnchorWallet } from './client.js';
import {
  DeliveryNotSubmittedError,
  EscrowAlreadyResolvedError,
  EscrowNotFoundError,
} from './errors.js';
import {
  DEVNET_USDC_MINT,
  getAssociatedTokenAddress,
  makeEscrowProgram,
  sendWithRetry,
} from './escrow-utils.js';

export async function claimEscrowTimeout(
  connection: Connection,
  wallet: AnchorWallet,
  escrowId: string,
  usdcMint: PublicKey = DEVNET_USDC_MINT,
): Promise<string> {
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
  const ix = await program.methods.claimTimeout().accounts(accts).instruction();

  return sendWithRetry(connection, wallet, ix);
}
