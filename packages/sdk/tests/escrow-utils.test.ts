import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { getAssociatedTokenAddress } from '../src/escrow-utils.js';

// Regression test for Task #47 / R1 from M1.5 smoke:
// A typo in the hardcoded ASSOCIATED_TOKEN_PROGRAM_ID caused SDK-derived ATAs to differ
// from those created by @solana/spl-token, breaking hire() balance pre-flight checks.
// Fix: import ASSOCIATED_TOKEN_PROGRAM_ID directly from @solana/spl-token.

const DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

describe('getAssociatedTokenAddress', () => {
  it('matches @solana/spl-token canonical derivation for devnet USDC mint', () => {
    const owner = Keypair.generate().publicKey;
    const sdkAta = getAssociatedTokenAddress(DEVNET_USDC_MINT, owner);
    const splAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, owner);
    expect(sdkAta.equals(splAta)).toBe(true);
  });

  it('matches @solana/spl-token canonical derivation for arbitrary mint', () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const sdkAta = getAssociatedTokenAddress(mint, owner);
    const splAta = getAssociatedTokenAddressSync(mint, owner);
    expect(sdkAta.equals(splAta)).toBe(true);
  });

  it('produces deterministic address for the same (mint, owner) pair', () => {
    const owner = Keypair.generate().publicKey;
    const mint = DEVNET_USDC_MINT;
    const ata1 = getAssociatedTokenAddress(mint, owner);
    const ata2 = getAssociatedTokenAddress(mint, owner);
    expect(ata1.equals(ata2)).toBe(true);
  });

  it('produces different addresses for different owners', () => {
    const owner1 = Keypair.generate().publicKey;
    const owner2 = Keypair.generate().publicKey;
    const ata1 = getAssociatedTokenAddress(DEVNET_USDC_MINT, owner1);
    const ata2 = getAssociatedTokenAddress(DEVNET_USDC_MINT, owner2);
    expect(ata1.equals(ata2)).toBe(false);
  });
});
