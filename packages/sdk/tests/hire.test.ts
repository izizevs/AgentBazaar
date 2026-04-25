import {
  type Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorWallet } from '../src/client.js';
import {
  EscrowAlreadyExistsError,
  InsufficientFundsError,
  InvalidListingError,
  TransactionFailedError,
  ValidationError,
} from '../src/errors.js';
import type { HireInput } from '../src/types.js';

// ─── mocks ────────────────────────────────────────────────────────────────────

const mockFetchNullable = vi.fn();
const mockInstruction = vi.fn();
const mockCreateEscrow = vi.fn();

vi.mock('@coral-xyz/anchor', () => {
  class AnchorProvider {}
  class Program {
    account = { escrowAccount: { fetchNullable: mockFetchNullable } };
    methods = { createEscrow: mockCreateEscrow };
  }
  return { AnchorProvider, Program };
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeWallet(keypair = Keypair.generate()) {
  const mock = {
    publicKey: keypair.publicKey,
    signTransaction: vi.fn(async <T>(tx: T) => {
      if (tx instanceof Transaction) tx.sign(keypair);
      return tx;
    }),
    signAllTransactions: vi.fn(async <T>(txs: T[]) => {
      for (const tx of txs) if (tx instanceof Transaction) (tx as Transaction).sign(keypair);
      return txs;
    }),
  };
  return mock as unknown as typeof mock & AnchorWallet;
}

const MOCK_BLOCKHASH = '11111111111111111111111111111111';
const LISTING_PDA = new PublicKey('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd');

function makeConnection(balance = '10000000') {
  return {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: MOCK_BLOCKHASH,
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: vi.fn().mockResolvedValue('mocksig-hire'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getTokenAccountBalance: vi.fn().mockResolvedValue({
      value: { amount: balance, decimals: 6 },
    }),
  } as unknown as Connection;
}

function validInput(overrides: Partial<HireInput> = {}): HireInput {
  return {
    budget: 1_000_000n,
    sla: { maxLatencyMs: 3000 },
    timeout: 3600,
    ...overrides,
  };
}

const { hireAgent } = await import('../src/hire.js');

// ─── suite ───────────────────────────────────────────────────────────────────

describe('hireAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchNullable.mockResolvedValue(null);
    mockInstruction.mockResolvedValue(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey('11111111111111111111111111111111'),
        data: Buffer.alloc(0),
      }),
    );
    mockCreateEscrow.mockReturnValue({
      accounts: () => ({ instruction: mockInstruction }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── validation ────────────────────────────────────────────────────────────

  it('throws ValidationError when budget is zero', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    await expect(
      hireAgent(conn, wallet, LISTING_PDA.toBase58(), validInput({ budget: 0n })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when budget is negative', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    await expect(
      hireAgent(conn, wallet, LISTING_PDA.toBase58(), validInput({ budget: -1n })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when timeout is zero', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    await expect(
      hireAgent(conn, wallet, LISTING_PDA.toBase58(), validInput({ timeout: 0 })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws InvalidListingError when agentId is not a valid public key', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    await expect(hireAgent(conn, wallet, 'not-a-pubkey', validInput())).rejects.toBeInstanceOf(
      InvalidListingError,
    );
  });

  // ─── insufficient funds ────────────────────────────────────────────────────

  it('throws InsufficientFundsError when balance is below budget', async () => {
    const wallet = makeWallet();
    const conn = makeConnection('500000'); // 0.5 USDC < 1 USDC budget
    await expect(
      hireAgent(conn, wallet, LISTING_PDA.toBase58(), validInput({ budget: 1_000_000n })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('InsufficientFundsError carries required/available fields', async () => {
    const wallet = makeWallet();
    const conn = makeConnection('0');
    const err = await hireAgent(
      conn,
      wallet,
      LISTING_PDA.toBase58(),
      validInput({ budget: 5_000_000n }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).required).toBe(5_000_000n);
    expect((err as InsufficientFundsError).available).toBe(0n);
  });

  // ─── idempotency ───────────────────────────────────────────────────────────

  it('returns existing handle without sending tx when escrow already in created state', async () => {
    mockFetchNullable.mockResolvedValue({ state: { created: {} } });
    const wallet = makeWallet();
    const conn = makeConnection();
    const result = await hireAgent(
      conn,
      wallet,
      LISTING_PDA.toBase58(),
      validInput({ nonce: 12345n }),
    );
    expect(result.signature).toBe('');
    expect(result.escrowPda).toBeInstanceOf(PublicKey);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('throws EscrowAlreadyExistsError when escrow exists in delivered state', async () => {
    mockFetchNullable.mockResolvedValue({ state: { delivered: {} } });
    const wallet = makeWallet();
    const conn = makeConnection();
    await expect(
      hireAgent(conn, wallet, LISTING_PDA.toBase58(), validInput({ nonce: 12345n })),
    ).rejects.toBeInstanceOf(EscrowAlreadyExistsError);
  });

  // ─── success path ──────────────────────────────────────────────────────────

  it('returns EscrowHandle with escrowPda, vaultPda, signature on success', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    const result = await hireAgent(
      conn,
      wallet,
      LISTING_PDA.toBase58(),
      validInput({ nonce: 42n }),
    );
    expect(result.escrowPda).toBeInstanceOf(PublicKey);
    expect(result.vaultPda).toBeInstanceOf(PublicKey);
    expect(result.signature).toBe('mocksig-hire');
  });

  it('derives deterministic escrow PDA for same buyer+listing+nonce', async () => {
    const keypair = Keypair.generate();
    const wallet1 = makeWallet(keypair);
    const wallet2 = makeWallet(keypair);

    const r1 = await hireAgent(
      makeConnection(),
      wallet1,
      LISTING_PDA.toBase58(),
      validInput({ nonce: 999n }),
    );
    vi.clearAllMocks();
    mockFetchNullable.mockResolvedValue(null);
    mockInstruction.mockResolvedValue(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey('11111111111111111111111111111111'),
        data: Buffer.alloc(0),
      }),
    );
    const r2 = await hireAgent(
      makeConnection(),
      wallet2,
      LISTING_PDA.toBase58(),
      validInput({ nonce: 999n }),
    );

    expect(r1.escrowPda.toBase58()).toBe(r2.escrowPda.toBase58());
    expect(r1.vaultPda.toBase58()).toBe(r2.vaultPda.toBase58());
  });

  it('vault PDA differs from escrow PDA', async () => {
    const wallet = makeWallet();
    const result = await hireAgent(
      makeConnection(),
      wallet,
      LISTING_PDA.toBase58(),
      validInput({ nonce: 1n }),
    );
    expect(result.escrowPda.toBase58()).not.toBe(result.vaultPda.toBase58());
  });

  it('passes timeout as relative seconds (not absolute timestamp) to createEscrow', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    await hireAgent(conn, wallet, LISTING_PDA.toBase58(), validInput({ nonce: 1n, timeout: 3600 }));
    // arg index 3 is the deadline; must be 3600 (relative offset), not ~unix_now+3600
    const deadlineArg = mockCreateEscrow.mock.calls[0]?.[3];
    expect(deadlineArg?.toString()).toBe('3600');
  });

  // ─── retry + priority fee escalation ───────────────────────────────────────

  it('retries on send failure and returns on second attempt', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    (conn.sendRawTransaction as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('blockhash expired'))
      .mockResolvedValue('sig-retry');
    const result = await hireAgent(conn, wallet, LISTING_PDA.toBase58(), validInput({ nonce: 1n }));
    expect(result.signature).toBe('sig-retry');
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it('throws TransactionFailedError after all 3 attempts fail', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    (conn.sendRawTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('network error'),
    );
    await expect(
      hireAgent(conn, wallet, LISTING_PDA.toBase58(), validInput({ nonce: 1n })),
    ).rejects.toBeInstanceOf(TransactionFailedError);
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(3);
  });

  it('throws TransactionFailedError when confirmTransaction reports value.err', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    (conn.confirmTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { err: { InstructionError: [0, { Custom: 6001 }] } },
    });
    await expect(
      hireAgent(conn, wallet, LISTING_PDA.toBase58(), validInput({ nonce: 1n })),
    ).rejects.toBeInstanceOf(TransactionFailedError);
  });
});
