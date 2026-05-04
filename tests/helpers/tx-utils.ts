import type { BazaarRegistry } from '@agent-bazaar/idl';
import { BazaarRegistryIDL, computeCapabilityHash } from '@agent-bazaar/idl';
import { clusterFromConnection, PROGRAM_IDS } from '@agent-bazaar/sdk';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import {
  type Connection,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from '@solana/web3.js';

// Re-export so test files don't import directly from @agent-bazaar/idl.
export { computeCapabilityHash };

/**
 * Derive the ServiceListing PDA for a given owner + capability string.
 * Mirrors the derivation in packages/sdk/src/register.ts.
 * The registry program ID is resolved from the connection's RPC endpoint.
 */
export async function deriveListingPda(
  ownerPublicKey: PublicKey,
  capability: string,
  connection: Connection,
): Promise<PublicKey> {
  const registryProgramId = PROGRAM_IDS[clusterFromConnection(connection)].registry;
  const capHash = await computeCapabilityHash(capability);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('listing'), ownerPublicKey.toBuffer(), Buffer.from(capHash)],
    registryProgramId,
  );
  return pda;
}

/**
 * Build an Anchor Program<BazaarRegistry> for read-only queries.
 * Uses a no-op wallet since tests only need account reads (not signing).
 */
export function buildRegistryProgram(connection: Connection): Program<BazaarRegistry> {
  const noopWallet = {
    publicKey: PublicKey.default,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => tx,
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> => txs,
  };
  const provider = new AnchorProvider(connection, noopWallet, { commitment: 'confirmed' });
  return new Program<BazaarRegistry>(BazaarRegistryIDL, provider);
}

/**
 * Wait for a transaction to confirm then return the slot it landed in.
 */
export async function confirmTx(connection: Connection, signature: string): Promise<number> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (result.value.err) {
    throw new Error(`Transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
  }
  const status = await connection.getSignatureStatus(signature);
  return status.value?.slot ?? 0;
}
