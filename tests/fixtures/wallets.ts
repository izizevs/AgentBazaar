import { type Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js';

const AIRDROP_SOL = 2;

export interface FundedWallet {
  keypair: Keypair;
  publicKey: PublicKey;
}

/**
 * Generate n Keypairs and fund each with AIRDROP_SOL via devnet airdrop.
 * Waits for each airdrop to confirm before returning.
 */
export async function createFundedWallets(
  connection: Connection,
  n: number,
): Promise<FundedWallet[]> {
  const wallets: FundedWallet[] = [];

  for (let i = 0; i < n; i++) {
    const keypair = Keypair.generate();
    const sig = await connection.requestAirdrop(keypair.publicKey, AIRDROP_SOL * LAMPORTS_PER_SOL);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );

    wallets.push({ keypair, publicKey: keypair.publicKey });
  }

  return wallets;
}
