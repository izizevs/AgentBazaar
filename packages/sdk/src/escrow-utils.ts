import type { BazaarEscrow } from '@agentbazaar/idl';
import { BazaarEscrowIDL } from '@agentbazaar/idl';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { AnchorWallet } from './client.js';
import {
  EscrowExpiredError,
  EscrowNotExpiredError,
  TransactionFailedError,
  UnauthorizedError,
} from './errors.js';
import { clusterFromConnection, PROGRAM_IDS } from './program-ids.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bC8');

/** Returns the bazaar-escrow program ID for the cluster inferred from `connection`. */
export function getEscrowProgramId(connection: Connection): PublicKey {
  return PROGRAM_IDS[clusterFromConnection(connection)].escrow;
}

export const DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

export const RETRY_PRIORITY_FEES = [0, 100_000, 500_000] as const;

export function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function makeEscrowProgram(
  connection: Connection,
  wallet: AnchorWallet,
): Program<BazaarEscrow> {
  // biome-ignore lint/suspicious/noExplicitAny: Anchor's Wallet interface requires a payer Keypair; structural AnchorWallet is compatible at runtime
  const provider = new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
  return new Program<BazaarEscrow>(BazaarEscrowIDL, provider);
}

export async function sendWithRetry(
  connection: Connection,
  wallet: AnchorWallet,
  ix: TransactionInstruction,
): Promise<string> {
  let lastError: Error | undefined;

  for (const priorityFee of RETRY_PRIORITY_FEES) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: wallet.publicKey });
      if (priorityFee > 0) {
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
      }
      tx.add(ix);
      const signed = await wallet.signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize());
      const result = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (result.value.err) {
        const mapped = mapConfirmError(result.value.err, signature);
        throw mapped;
      }
      return signature;
    } catch (err) {
      const asError = err instanceof Error ? err : new Error(String(err));
      if (!isTransient(err)) throw asError;
      lastError = asError;
    }
  }

  throw lastError instanceof TransactionFailedError
    ? lastError
    : new TransactionFailedError(
        lastError?.message ?? 'Transaction failed after all retry attempts',
      );
}

function isTransient(err: unknown): boolean {
  // Program errors are deterministic — retrying won't change the outcome
  if (err instanceof UnauthorizedError) return false;
  if (err instanceof EscrowExpiredError) return false;
  if (err instanceof EscrowNotExpiredError) return false;
  // TransactionFailedError with a signature means the tx confirmed but the program rejected it
  if (err instanceof TransactionFailedError && err.signature !== undefined) return false;
  return true;
}

function mapConfirmError(err: unknown, signature: string): Error {
  const code = extractCustomErrorCode(err);
  if (code !== undefined) {
    const msg = `Program error ${code}: ${JSON.stringify(err)}`;
    switch (code) {
      case 6000:
        return new UnauthorizedError(msg);
      case 6005:
        return new EscrowExpiredError(msg);
      case 6006:
        return new EscrowNotExpiredError(msg);
      default:
        return new TransactionFailedError(msg, signature);
    }
  }
  return new TransactionFailedError(`Program error: ${JSON.stringify(err)}`, signature);
}

function extractCustomErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const obj = err as Record<string, unknown>;
  const ixError = obj.InstructionError;
  if (!Array.isArray(ixError) || ixError.length < 2) return undefined;
  const inner = ixError[1] as Record<string, unknown>;
  if (typeof inner?.Custom === 'number') return inner.Custom;
  return undefined;
}
