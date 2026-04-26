/**
 * USDC mint constants and test-local-validator mint scaffold.
 *
 * For devnet E2E tests use DEVNET_USDC_MINT — the real Circle devnet USDC
 * whose address is hard-coded in the bazaar-escrow program constraint.
 *
 * For unit tests that run against a local validator (where Circle USDC does not
 * exist) use deployLocalValidatorMint() to spin up a fresh mint.
 */
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  type Connection,
  Keypair,
  type PublicKey as PK,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import type { FundedWallet } from './wallets.js';

/**
 * Circle devnet USDC — the mint address the bazaar-escrow program constrains
 * against.  All devnet E2E tests must use this address.
 */
export const DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

export interface TestMint {
  mint: PK;
  mintAuthority: Keypair;
}

/**
 * Deploy a fresh SPL Token mint with 6 decimals (matching USDC) on a local
 * test validator.  Do NOT call this in devnet E2E tests — the bazaar-escrow
 * program rejects any mint that is not DEVNET_USDC_MINT.
 *
 * Kept for unit tests that need an arbitrary mint on a local-validator cluster.
 */
export async function deployLocalValidatorMint(
  connection: Connection,
  payer: FundedWallet,
): Promise<TestMint> {
  const mintAuthority = payer.keypair;
  const mintKeypair = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      6, // 6 decimals — matches USDC
      mintAuthority.publicKey,
      null,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer.keypair, mintKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  return { mint: mintKeypair.publicKey, mintAuthority };
}

/**
 * Mint `amount` (in micro-units, 6 decimals) of a local-validator test token
 * to each wallet.  Creates an ATA for each recipient if it doesn't exist.
 *
 * For use with deployLocalValidatorMint() in unit tests only.
 */
export async function mintToWallets(
  connection: Connection,
  testMint: TestMint,
  payer: FundedWallet,
  recipients: FundedWallet[],
  amount: bigint,
): Promise<void> {
  for (const recipient of recipients) {
    const ata = getAssociatedTokenAddressSync(testMint.mint, recipient.publicKey);

    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        recipient.publicKey,
        testMint.mint,
      ),
      createMintToInstruction(testMint.mint, ata, testMint.mintAuthority.publicKey, amount),
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer.keypair, testMint.mintAuthority);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
  }
}
