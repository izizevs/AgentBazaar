import type { BazaarEscrow } from '@agent-bazaar/idl';
import { BazaarEscrowIDL } from '@agent-bazaar/idl';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  SendTransactionError,
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
import { type Cluster, clusterFromConnection, PROGRAM_IDS } from './program-ids.js';

export { TOKEN_PROGRAM_ID };

/** Returns the bazaar-escrow program ID for the cluster inferred from `connection`. */
export function getEscrowProgramId(connection: Connection): PublicKey {
  return PROGRAM_IDS[clusterFromConnection(connection)].escrow;
}

/**
 * Per-cluster USDC mint addresses.
 *
 * - `mainnet-beta`: Circle's canonical mainnet USDC mint
 * - `devnet`: Circle's canonical devnet USDC faucet mint
 * - `testnet` / `localnet`: placeholder (SystemProgram ID) — not deployed; caller
 *   must supply the mint address directly when testing on these clusters.
 */
export const USDC_MINTS: Record<Cluster, PublicKey> = {
  'mainnet-beta': new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  devnet: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  testnet: new PublicKey('11111111111111111111111111111111'), // not deployed
  localnet: new PublicKey('11111111111111111111111111111111'), // user-supplied locally
};

/**
 * Returns the canonical USDC mint for the cluster inferred from `connection`.
 *
 * For `testnet` and `localnet` the returned value is `SystemProgram` (11111…)
 * because USDC is not deployed there — callers that target those clusters must
 * supply their own test-mint address.
 */
export function getUsdcMint(connection: Connection): PublicKey {
  return USDC_MINTS[clusterFromConnection(connection)];
}

/**
 * @deprecated Use {@link getUsdcMint} or {@link USDC_MINTS} for cluster-aware access.
 *
 * Kept for backwards compatibility with code that imported `DEVNET_USDC_MINT` directly
 * before the per-cluster table was introduced (Task #53, 0.2.1).
 */
export const DEVNET_USDC_MINT = USDC_MINTS.devnet;

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
  ixOrIxs: TransactionInstruction | TransactionInstruction[],
): Promise<string> {
  const ixs = Array.isArray(ixOrIxs) ? ixOrIxs : [ixOrIxs];
  let lastError: Error | undefined;

  for (const priorityFee of RETRY_PRIORITY_FEES) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: wallet.publicKey });
      if (priorityFee > 0) {
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
      }
      for (const ix of ixs) tx.add(ix);
      const signed = await wallet.signTransaction(tx);

      let signature: string;
      try {
        signature = await connection.sendRawTransaction(signed.serialize());
      } catch (sendErr) {
        // sendRawTransaction throws SendTransactionError when the node rejects the tx
        // pre-flight (simulation). Map simulation program errors to typed exceptions so
        // callers get the same typed-error experience as post-confirm errors.
        //
        // Duck-type instead of `instanceof SendTransactionError` because pnpm may resolve
        // two different @solana/web3.js instances (one in the SDK bundle, one in the test
        // or app process), making instanceof checks cross-realm failures.
        // The SendTransactionError in web3.js 1.98+ exposes `transactionMessage` property.
        const isSendTxError =
          sendErr instanceof SendTransactionError ||
          (sendErr instanceof Error &&
            typeof (sendErr as unknown as Record<string, unknown>).transactionMessage === 'string');
        if (isSendTxError && sendErr instanceof Error) {
          const txErr = sendErr as unknown as {
            logs?: string[] | undefined;
            message: string;
          };
          const logs = txErr.logs ?? [];
          const mapped = mapSimulationError(logs, txErr.message);
          throw mapped;
        }
        throw sendErr;
      }

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

/**
 * Map a numeric Anchor/program error code to a typed SDK exception.
 *
 * This lookup table is shared by both `mapConfirmError` (post-confirm errors from
 * `confirmTransaction`) and `mapSimulationError` (pre-flight errors from
 * `sendRawTransaction`/`SendTransactionError`).
 *
 * Codes 6000–6010 match the bazaar-escrow program's custom error enum.
 */
function mapProgramCode(code: number, msg: string, signature?: string): Error {
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

function mapConfirmError(err: unknown, signature: string): Error {
  const code = extractCustomErrorCode(err);
  if (code !== undefined) {
    const msg = `Program error ${code}: ${JSON.stringify(err)}`;
    return mapProgramCode(code, msg, signature);
  }
  return new TransactionFailedError(`Program error: ${JSON.stringify(err)}`, signature);
}

/**
 * Parse simulation logs from a `SendTransactionError` and map any Anchor / custom
 * program error to a typed exception.
 *
 * Log formats handled:
 * 1. Anchor: `Program log: AnchorError occurred. Error Code: <Name>. Error Number: <N>.`
 * 2. Raw (logs array): `Program <ID> failed: custom program error: 0x<hex>`
 * 3. Fallback (transactionMessage string, web3.js path where `err.logs` is undefined):
 *    `"Transaction simulation failed: Error processing Instruction 0: custom program error: 0x178a"`
 *    The hex code is extracted via regex and looked up in the error-code table.
 */
export function mapSimulationError(logs: string[], fallbackMessage: string): Error {
  for (const line of logs) {
    // Anchor structured error log
    const anchorMatch = line.match(/Error Number:\s*(\d+)/);
    if (anchorMatch) {
      const code = Number(anchorMatch[1]);
      return mapProgramCode(code, `Simulation failed — program error ${code}: ${line}`);
    }
    // Raw custom program error (hex)
    const rawMatch = line.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
    if (rawMatch?.[1] !== undefined) {
      const code = Number.parseInt(rawMatch[1], 16);
      return mapProgramCode(code, `Simulation failed — program error ${code}: ${line}`);
    }
  }

  // Fallback: when err.logs is undefined (web3.js path), parse the transactionMessage string.
  // e.g. "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x178a"
  const msgMatch = fallbackMessage.match(/custom program error:\s*0x([0-9a-f]+)/i);
  if (msgMatch?.[1] !== undefined) {
    const code = Number.parseInt(msgMatch[1], 16);
    return mapProgramCode(code, `Simulation failed — program error ${code}: ${fallbackMessage}`);
  }

  return new TransactionFailedError(`Simulation failed: ${fallbackMessage}`);
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
