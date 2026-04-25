/**
 * Test USDC mint scaffold for M1 escrow tests.
 * Not required for M0 (no escrow), but kept here so M1 tests can import it
 * without boilerplate.
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
  type PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import type { FundedWallet } from './wallets.js';

export interface TestMint {
  mint: PublicKey;
  mintAuthority: Keypair;
}

/**
 * Deploy a fresh SPL Token mint with 6 decimals (matching USDC).
 * The payer keypair acts as both payer and mint authority.
 */
export async function deployTestMint(
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
 * Mint `amount` (in micro-units, 6 decimals) of the test token to each wallet.
 * Creates an ATA for the wallet if it doesn't exist.
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
