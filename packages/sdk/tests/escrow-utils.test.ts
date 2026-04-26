import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Connection } from '@solana/web3.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  EscrowExpiredError,
  EscrowNotExpiredError,
  TransactionFailedError,
  UnauthorizedError,
} from '../src/errors.js';
import {
  DEVNET_USDC_MINT,
  getAssociatedTokenAddress,
  getUsdcMint,
  mapSimulationError,
  USDC_MINTS,
} from '../src/escrow-utils.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function conn(endpoint: string): Connection {
  return { rpcEndpoint: endpoint } as unknown as Connection;
}

// ─── Regression: Task #47 / R1 from M1.5 smoke ───────────────────────────────
// A typo in the hardcoded ASSOCIATED_TOKEN_PROGRAM_ID caused SDK-derived ATAs to differ
// from those created by @solana/spl-token, breaking hire() balance pre-flight checks.
// Fix: import ASSOCIATED_TOKEN_PROGRAM_ID directly from @solana/spl-token.

describe('getAssociatedTokenAddress', () => {
  it('matches @solana/spl-token canonical derivation for devnet USDC mint', () => {
    const owner = Keypair.generate().publicKey;
    const sdkAta = getAssociatedTokenAddress(USDC_MINTS.devnet, owner);
    const splAta = getAssociatedTokenAddressSync(USDC_MINTS.devnet, owner);
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
    const mint = USDC_MINTS.devnet;
    const ata1 = getAssociatedTokenAddress(mint, owner);
    const ata2 = getAssociatedTokenAddress(mint, owner);
    expect(ata1.equals(ata2)).toBe(true);
  });

  it('produces different addresses for different owners', () => {
    const owner1 = Keypair.generate().publicKey;
    const owner2 = Keypair.generate().publicKey;
    const ata1 = getAssociatedTokenAddress(USDC_MINTS.devnet, owner1);
    const ata2 = getAssociatedTokenAddress(USDC_MINTS.devnet, owner2);
    expect(ata1.equals(ata2)).toBe(false);
  });
});

// ─── USDC_MINTS table (Task #53, L4) ─────────────────────────────────────────

describe('USDC_MINTS', () => {
  it('devnet entry matches Circle canonical devnet faucet address', () => {
    expect(USDC_MINTS.devnet.toBase58()).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  });

  it('mainnet-beta entry matches Circle canonical mainnet address', () => {
    expect(USDC_MINTS['mainnet-beta'].toBase58()).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });

  it('testnet and localnet entries are placeholder SystemProgram ID', () => {
    const placeholder = new PublicKey('11111111111111111111111111111111');
    expect(USDC_MINTS.testnet.equals(placeholder)).toBe(true);
    expect(USDC_MINTS.localnet.equals(placeholder)).toBe(true);
  });

  it('DEVNET_USDC_MINT still equals USDC_MINTS.devnet (backwards compat)', () => {
    expect(DEVNET_USDC_MINT.equals(USDC_MINTS.devnet)).toBe(true);
  });
});

// ─── getUsdcMint (Task #53, L4) ──────────────────────────────────────────────

describe('getUsdcMint', () => {
  it('returns devnet mint for devnet connection', () => {
    expect(getUsdcMint(conn('https://api.devnet.solana.com')).toBase58()).toBe(
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    );
  });

  it('returns mainnet-beta mint for mainnet connection', () => {
    expect(getUsdcMint(conn('https://api.mainnet-beta.solana.com')).toBase58()).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });

  it('returns localnet placeholder for localhost connection', () => {
    const result = getUsdcMint(conn('http://localhost:8899'));
    expect(result.equals(new PublicKey('11111111111111111111111111111111'))).toBe(true);
  });
});

// ─── mapSimulationError (Task #51) ────────────────────────────────────────────

describe('mapSimulationError', () => {
  it('maps Anchor AnchorError log (code 6000) to UnauthorizedError', () => {
    const logs = [
      'Program EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2 invoke [1]',
      'Program log: AnchorError occurred. Error Code: Unauthorized. Error Number: 6000. Error Message: Unauthorized.',
      'Program EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2 failed: custom program error: 0x1770',
    ];
    const err = mapSimulationError(logs, 'simulation failed');
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('maps Anchor AnchorError log (code 6005) to EscrowExpiredError', () => {
    const logs = [
      'Program log: AnchorError occurred. Error Code: EscrowExpired. Error Number: 6005. Error Message: Escrow deadline has passed.',
    ];
    const err = mapSimulationError(logs, 'simulation failed');
    expect(err).toBeInstanceOf(EscrowExpiredError);
  });

  it('maps Anchor AnchorError log (code 6006) to EscrowNotExpiredError', () => {
    const logs = [
      'Program log: AnchorError occurred. Error Code: DeadlineNotYetPassed. Error Number: 6006. Error Message: Deadline not yet passed.',
    ];
    const err = mapSimulationError(logs, 'simulation failed');
    expect(err).toBeInstanceOf(EscrowNotExpiredError);
  });

  it('maps raw hex custom program error 0x1770 (6000) to UnauthorizedError', () => {
    const logs = [
      'Program EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2 failed: custom program error: 0x1770',
    ];
    const err = mapSimulationError(logs, 'simulation failed');
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('maps raw hex custom program error 0x1775 (6005) to EscrowExpiredError', () => {
    const logs = [
      'Program EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2 failed: custom program error: 0x1775',
    ];
    const err = mapSimulationError(logs, 'simulation failed');
    expect(err).toBeInstanceOf(EscrowExpiredError);
  });

  it('maps unknown code to TransactionFailedError', () => {
    const logs = [
      'Program log: AnchorError occurred. Error Code: SomeOther. Error Number: 6099. Error Message: unknown.',
    ];
    const err = mapSimulationError(logs, 'simulation failed');
    expect(err).toBeInstanceOf(TransactionFailedError);
  });

  it('returns TransactionFailedError when logs are empty', () => {
    const err = mapSimulationError([], 'node rejected preflight');
    expect(err).toBeInstanceOf(TransactionFailedError);
    expect(err.message).toContain('node rejected preflight');
  });
});
