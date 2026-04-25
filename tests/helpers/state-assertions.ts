import type { Connection, PublicKey } from '@solana/web3.js';
import { expect } from 'vitest';
import { buildRegistryProgram } from './tx-utils.js';

export interface ExpectedListing {
  /** On-chain price in lamports (mapped from priceUsdc in register() input). */
  priceLamports?: bigint;
  isActive?: boolean;
  owner?: PublicKey;
}

/**
 * Assert that a ServiceListing PDA exists on-chain and matches expected fields.
 * Throws a Vitest assertion error if any field mismatches or the account is missing.
 */
export async function assertListingExists(
  connection: Connection,
  pda: PublicKey,
  expected: ExpectedListing,
): Promise<void> {
  const program = buildRegistryProgram(connection);
  const listing = await program.account.serviceListing.fetch(pda);

  expect(listing, `ServiceListing at ${pda.toBase58()} not found`).toBeTruthy();

  if (expected.isActive !== undefined) {
    expect(listing.isActive).toBe(expected.isActive);
  }
  if (expected.owner !== undefined) {
    expect(listing.owner.toBase58()).toBe(expected.owner.toBase58());
  }
  if (expected.priceLamports !== undefined) {
    const onChainPrice = BigInt(listing.priceLamports.toString());
    expect(onChainPrice).toBe(expected.priceLamports);
  }
}

/**
 * Assert that a ServiceListing PDA does NOT exist on-chain.
 */
export async function assertNotFound(connection: Connection, pda: PublicKey): Promise<void> {
  const program = buildRegistryProgram(connection);
  const listing = await program.account.serviceListing.fetchNullable(pda);
  expect(listing, `Expected no listing at ${pda.toBase58()} but found one`).toBeNull();
}
