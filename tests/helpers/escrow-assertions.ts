import type { BazaarEscrow } from '@agent-bazaar/idl';
import { BazaarEscrowIDL } from '@agent-bazaar/idl';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import type { Connection } from '@solana/web3.js';
import { PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import { expect } from 'vitest';

type EscrowStateKey = 'created' | 'delivered' | 'confirmed' | 'timeoutClaimed' | 'disputed';

const noopWallet = {
  publicKey: PublicKey.default,
  signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => tx,
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]> => txs,
};

function buildEscrowProgram(connection: Connection): Program<BazaarEscrow> {
  const provider = new AnchorProvider(connection, noopWallet, { commitment: 'confirmed' });
  return new Program<BazaarEscrow>(BazaarEscrowIDL, provider);
}

export async function assertEscrowState(
  connection: Connection,
  escrowPda: PublicKey,
  expected: EscrowStateKey,
): Promise<void> {
  const program = buildEscrowProgram(connection);
  const escrow = await program.account.escrowAccount.fetch(escrowPda);
  expect(
    expected in escrow.state,
    `Expected escrow ${escrowPda.toBase58()} to be in state '${expected}', got ${JSON.stringify(escrow.state)}`,
  ).toBe(true);
}

export async function assertVaultBalance(
  connection: Connection,
  vaultPda: PublicKey,
  expectedAmount: bigint,
): Promise<void> {
  const balance = await connection.getTokenAccountBalance(vaultPda);
  expect(
    BigInt(balance.value.amount),
    `Expected vault ${vaultPda.toBase58()} balance ${expectedAmount}, got ${balance.value.amount}`,
  ).toBe(expectedAmount);
}

export async function assertTokenBalance(
  connection: Connection,
  tokenAccount: PublicKey,
  expectedAmount: bigint,
): Promise<void> {
  const balance = await connection.getTokenAccountBalance(tokenAccount);
  expect(
    BigInt(balance.value.amount),
    `Expected token account ${tokenAccount.toBase58()} balance ${expectedAmount}, got ${balance.value.amount}`,
  ).toBe(expectedAmount);
}
