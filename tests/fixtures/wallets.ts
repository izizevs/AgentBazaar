import {
  getOrCreateAssociatedTokenAccount,
  TokenAccountNotFoundError,
  transferChecked,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  type Keypair as KP,
  LAMPORTS_PER_SOL,
  type PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { DEVNET_USDC_MINT } from './usdc-mint.js';

/**
 * Retry wrapper for getOrCreateAssociatedTokenAccount.
 *
 * spl-token 0.4.x has a known race: after submitting the create-ATA tx, it
 * calls getAccount() to return the new account object.  Under 429 rate-limit
 * pressure (multiple parallel test suites) that fetch can receive a stale
 * "account not found" even though the tx confirmed.  Retry up to 5 times
 * with exponential back-off before propagating.
 */
async function getOrCreateAta(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  maxRetries = 5,
): ReturnType<typeof getOrCreateAssociatedTokenAccount> {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner);
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 8000);
        continue;
      }
      throw err;
    }
  }
  // unreachable; for type-checker only
  throw new Error('getOrCreateAta: exhausted retries');
}

const AIRDROP_SOL = 0.1;

// Helius devnet caps requestAirdrop at 1 SOL/project/day.
// Use the public devnet endpoint for airdrops to avoid that limit.
const PUBLIC_DEVNET_URL = 'https://api.devnet.solana.com';

export interface FundedWallet {
  keypair: Keypair;
  publicKey: PublicKey;
}

export interface FundingOptions {
  /**
   * If provided, fund new wallets by transferring SOL from this keypair
   * rather than using the devnet faucet.  The payer must already hold
   * enough SOL.  Falls back to airdrop when undefined.
   */
  payer?: KP;
  /** Override the RPC used for airdrops (default: public devnet endpoint). */
  airdropRpcUrl?: string;
}

/**
 * Generate n Keypairs and fund each with AIRDROP_SOL.
 * Funding strategy (in priority order):
 *   1. SOL transfer from `options.payer` keypair (fastest, no rate limits)
 *   2. requestAirdrop via `options.airdropRpcUrl` (default: public devnet endpoint)
 *
 * The main `connection` is used for confirmation regardless of funding strategy.
 */
export async function createFundedWallets(
  connection: Connection,
  n: number,
  options: FundingOptions = {},
): Promise<FundedWallet[]> {
  const wallets: FundedWallet[] = [];

  for (let i = 0; i < n; i++) {
    const keypair = Keypair.generate();
    await fundWallet(connection, keypair, options);
    wallets.push({ keypair, publicKey: keypair.publicKey });
  }

  return wallets;
}

async function fundWallet(
  connection: Connection,
  keypair: Keypair,
  { payer, airdropRpcUrl }: FundingOptions,
): Promise<void> {
  if (payer) {
    await fundFromPayer(connection, payer, keypair.publicKey);
  } else {
    await fundFromFaucet(connection, keypair.publicKey, airdropRpcUrl);
  }
}

async function fundFromPayer(
  connection: Connection,
  payer: KP,
  recipient: PublicKey,
): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: AIRDROP_SOL * LAMPORTS_PER_SOL,
    }),
  );
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
}

async function fundFromFaucet(
  connection: Connection,
  recipient: PublicKey,
  airdropRpcUrl?: string,
): Promise<void> {
  // Use a separate connection to the public devnet faucet when the main
  // connection is a Helius RPC (which rate-limits requestAirdrop heavily).
  const faucetConn = airdropRpcUrl
    ? new Connection(airdropRpcUrl, 'confirmed')
    : new Connection(PUBLIC_DEVNET_URL, 'confirmed');

  const sig = await faucetConn.requestAirdrop(recipient, AIRDROP_SOL * LAMPORTS_PER_SOL);

  // Confirm on the main connection so test assertions can query the same state.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
}

/**
 * Transfer `amountBaseUnits` of Circle devnet USDC (DEVNET_USDC_MINT) from the
 * master wallet to `recipient`.
 *
 * Steps:
 *   1. Derive master's ATA (or create if missing) — idempotent via
 *      getOrCreateAssociatedTokenAccount.
 *   2. Derive recipient's ATA (or create if missing) — pays SOL rent only when
 *      creating; idempotent on subsequent calls.
 *   3. transferChecked from master ATA to recipient ATA (skipped when amount is 0).
 *
 * The `master` keypair must already hold enough USDC and SOL for fees/rent.
 * Pass amountBaseUnits=0n to create the recipient ATA without transferring USDC.
 */
export async function fundUsdc(
  connection: Connection,
  master: Keypair,
  recipient: PublicKey,
  amountBaseUnits: bigint,
): Promise<void> {
  // Ensure both ATAs exist (idempotent — no-op if already created).
  const masterAccount = await getOrCreateAta(
    connection,
    master,
    DEVNET_USDC_MINT,
    master.publicKey,
  );
  const recipientAccount = await getOrCreateAta(connection, master, DEVNET_USDC_MINT, recipient);

  if (amountBaseUnits === 0n) {
    // Caller only wants the ATA created; no transfer needed.
    return;
  }

  await transferChecked(
    connection,
    master, // fee payer + source authority
    masterAccount.address, // source ATA
    DEVNET_USDC_MINT,
    recipientAccount.address, // destination ATA
    master, // owner of source ATA
    amountBaseUnits,
    6, // USDC decimals
  );
}
