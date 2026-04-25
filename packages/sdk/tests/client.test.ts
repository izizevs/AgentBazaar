import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentBazaar,
  AgentBazaarError,
  EscrowNotFoundError,
  InvalidListingError,
  NotImplementedError,
} from '../src/index.js';

// Minimal Wallet stub that satisfies the Anchor Wallet interface.
function makeWallet(keypair = Keypair.generate()) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
}

const TEST_RPC = 'https://api.devnet.solana.com';

// ─── constructor ──────────────────────────────────────────────────────────────

describe('AgentBazaar constructor', () => {
  it('accepts an RPC URL string and creates a Connection', () => {
    const client = new AgentBazaar({ wallet: makeWallet(), rpc: TEST_RPC });
    expect(client.connection).toBeInstanceOf(Connection);
  });

  it('accepts an existing Connection instance', () => {
    const conn = new Connection(TEST_RPC);
    const client = new AgentBazaar({ wallet: makeWallet(), rpc: conn });
    expect(client.connection).toBe(conn);
  });

  it('stores the wallet', () => {
    const wallet = makeWallet();
    const client = new AgentBazaar({ wallet, rpc: TEST_RPC });
    expect(client.wallet).toBe(wallet);
  });

  it('usdcMint defaults to devnet USDC', () => {
    const client = new AgentBazaar({ wallet: makeWallet(), rpc: TEST_RPC });
    expect(client.usdcMint).toBeInstanceOf(PublicKey);
    expect(client.usdcMint.toBase58()).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  });

  it('accepts custom usdcMint address', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const client = new AgentBazaar({ wallet: makeWallet(), rpc: TEST_RPC, usdcMint: mint });
    expect(client.usdcMint.toBase58()).toBe(mint);
  });
});

// ─── remaining stub ───────────────────────────────────────────────────────────

describe('AgentBazaar stubs — requestEvaluation', () => {
  it('requestEvaluation throws NotImplementedError', async () => {
    const client = new AgentBazaar({ wallet: makeWallet(), rpc: TEST_RPC });
    await expect(client.requestEvaluation('escrowId')).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ─── register stub ────────────────────────────────────────────────────────────

describe('AgentBazaar.register() stub', () => {
  it('throws NotImplementedError when pinataJwt not configured', async () => {
    const client = new AgentBazaar({ wallet: makeWallet(), rpc: TEST_RPC });
    await expect(
      client.register({
        name: 'test',
        description: 'test agent',
        capability: 'cap',
        priceUsdc: 1_000_000n,
        pricingModel: 'per_request',
        sla: {},
        endpoint: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ─── escrow method dispatch ───────────────────────────────────────────────────

describe('AgentBazaar escrow method dispatch', () => {
  const client = new AgentBazaar({ wallet: makeWallet(), rpc: TEST_RPC });

  it('hire() throws InvalidListingError for bad agentId', async () => {
    await expect(
      client.hire('not-a-pubkey', { budget: 1_000_000n, sla: {}, timeout: 3600 }),
    ).rejects.toBeInstanceOf(InvalidListingError);
  });

  it('deliver() throws EscrowNotFoundError for unknown escrowId', async () => {
    vi.mock('@coral-xyz/anchor', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@coral-xyz/anchor')>();
      return actual;
    });
    await expect(
      client.deliver('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd', {
        resultUri: 'https://x.com',
        resultHash: new Uint8Array(32),
      }),
    ).rejects.toBeDefined();
  });

  it('confirm() throws for unknown escrowId', async () => {
    await expect(
      client.confirm('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd', { score: 90 }),
    ).rejects.toBeDefined();
  });

  it('claimTimeout() throws for unknown escrowId', async () => {
    await expect(
      client.claimTimeout('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd'),
    ).rejects.toBeDefined();
  });

  it('dispute() throws ValidationError for empty reason', async () => {
    const { ValidationError } = await import('../src/errors.js');
    await expect(
      client.dispute('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd', { reason: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ─── error hierarchy ──────────────────────────────────────────────────────────

describe('error hierarchy', () => {
  it('NotImplementedError is an AgentBazaarError', () => {
    expect(new NotImplementedError('test')).toBeInstanceOf(AgentBazaarError);
  });

  it('NotImplementedError message includes method name', () => {
    const err = new NotImplementedError('register');
    expect(err.message).toContain('register');
  });

  it('EscrowNotFoundError is an AgentBazaarError', () => {
    expect(new EscrowNotFoundError('abc')).toBeInstanceOf(AgentBazaarError);
  });
});
