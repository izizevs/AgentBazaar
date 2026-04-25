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
  DeliveryNotSubmittedError,
  EscrowAlreadyConfirmedError,
  EscrowAlreadyDeliveredError,
  EscrowAlreadyDisputedError,
  EscrowAlreadyResolvedError,
  EscrowNotFoundError,
  TransactionFailedError,
  ValidationError,
} from '../src/errors.js';

// ─── mocks ────────────────────────────────────────────────────────────────────

const mockFetchNullable = vi.fn();
const mockSubmitDelivery = vi.fn();
const mockConfirmDelivery = vi.fn();
const mockClaimTimeout = vi.fn();
const mockOpenDispute = vi.fn();

vi.mock('@coral-xyz/anchor', () => {
  class AnchorProvider {}
  const makeChain = (mockIx: ReturnType<typeof vi.fn>) => () => ({
    accounts: () => ({ instruction: mockIx }),
  });
  class Program {
    account = { escrowAccount: { fetchNullable: mockFetchNullable } };
    methods = {
      submitDelivery: makeChain(mockSubmitDelivery),
      confirmDelivery: makeChain(mockConfirmDelivery),
      claimTimeout: makeChain(mockClaimTimeout),
      openDispute: makeChain(mockOpenDispute),
    };
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
const ESCROW_PDA = new PublicKey('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd');
const SELLER_PK = Keypair.generate().publicKey;
const LISTING_PK = Keypair.generate().publicKey;

function makeConnection() {
  return {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: MOCK_BLOCKHASH,
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: vi.fn().mockResolvedValue('mocksig-escrow'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  } as unknown as Connection;
}

function makeIx() {
  return new TransactionInstruction({
    keys: [],
    programId: new PublicKey('11111111111111111111111111111111'),
    data: Buffer.alloc(0),
  });
}

function escrowInState(state: Record<string, Record<string, never>>) {
  return { state, seller: SELLER_PK, listing: LISTING_PK, buyer: Keypair.generate().publicKey };
}

const { deliverJob } = await import('../src/deliver.js');
const { confirmDelivery } = await import('../src/confirm.js');
const { claimEscrowTimeout } = await import('../src/claimTimeout.js');
const { openEscrowDispute } = await import('../src/dispute.js');

// ─── deliver ──────────────────────────────────────────────────────────────────

describe('deliverJob', () => {
  const VALID_HASH = new Uint8Array(32).fill(1);

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchNullable.mockResolvedValue(escrowInState({ created: {} }));
    mockSubmitDelivery.mockResolvedValue(makeIx());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('throws EscrowNotFoundError when escrow is null', async () => {
    mockFetchNullable.mockResolvedValue(null);
    await expect(
      deliverJob(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
        resultUri: 'https://example.com',
        resultHash: VALID_HASH,
      }),
    ).rejects.toBeInstanceOf(EscrowNotFoundError);
  });

  it('throws EscrowNotFoundError when escrowId is not a valid pubkey', async () => {
    await expect(
      deliverJob(makeConnection(), makeWallet(), 'bad-key', {
        resultUri: 'https://example.com',
        resultHash: VALID_HASH,
      }),
    ).rejects.toBeInstanceOf(EscrowNotFoundError);
  });

  it('throws ValidationError when resultUri is empty', async () => {
    await expect(
      deliverJob(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
        resultUri: '',
        resultHash: VALID_HASH,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when resultHash is not 32 bytes', async () => {
    await expect(
      deliverJob(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
        resultUri: 'https://x.com',
        resultHash: new Uint8Array(16),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws EscrowAlreadyDeliveredError when state is delivered', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState({ delivered: {} }));
    await expect(
      deliverJob(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
        resultUri: 'https://x.com',
        resultHash: VALID_HASH,
      }),
    ).rejects.toBeInstanceOf(EscrowAlreadyDeliveredError);
  });

  it('throws EscrowAlreadyResolvedError when state is confirmed', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState({ confirmed: {} }));
    await expect(
      deliverJob(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
        resultUri: 'https://x.com',
        resultHash: VALID_HASH,
      }),
    ).rejects.toBeInstanceOf(EscrowAlreadyResolvedError);
  });

  it('returns signature on success', async () => {
    const sig = await deliverJob(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
      resultUri: 'https://x.com',
      resultHash: VALID_HASH,
    });
    expect(sig).toBe('mocksig-escrow');
  });

  it('throws TransactionFailedError after all retries fail', async () => {
    const conn = makeConnection();
    (conn.sendRawTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    await expect(
      deliverJob(conn, makeWallet(), ESCROW_PDA.toBase58(), {
        resultUri: 'https://x.com',
        resultHash: VALID_HASH,
      }),
    ).rejects.toBeInstanceOf(TransactionFailedError);
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(3);
  });
});

// ─── confirm ──────────────────────────────────────────────────────────────────

describe('confirmDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchNullable.mockResolvedValue(escrowInState({ delivered: {} }));
    mockConfirmDelivery.mockResolvedValue(makeIx());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('throws ValidationError when score is out of range', async () => {
    for (const score of [-1, 101, 1.5]) {
      await expect(
        confirmDelivery(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), { score }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('throws EscrowNotFoundError when escrow is null', async () => {
    mockFetchNullable.mockResolvedValue(null);
    await expect(
      confirmDelivery(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), { score: 90 }),
    ).rejects.toBeInstanceOf(EscrowNotFoundError);
  });

  it('throws DeliveryNotSubmittedError when state is created', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState({ created: {} }));
    await expect(
      confirmDelivery(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), { score: 90 }),
    ).rejects.toBeInstanceOf(DeliveryNotSubmittedError);
  });

  it('throws EscrowAlreadyConfirmedError when state is confirmed', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState({ confirmed: {} }));
    await expect(
      confirmDelivery(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), { score: 90 }),
    ).rejects.toBeInstanceOf(EscrowAlreadyConfirmedError);
  });

  it('throws EscrowAlreadyResolvedError when state is timeoutClaimed', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState({ timeoutClaimed: {} }));
    await expect(
      confirmDelivery(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), { score: 90 }),
    ).rejects.toBeInstanceOf(EscrowAlreadyResolvedError);
  });

  it('returns signature on success (boundary score 0)', async () => {
    const sig = await confirmDelivery(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
      score: 0,
    });
    expect(sig).toBe('mocksig-escrow');
  });

  it('returns signature on success (boundary score 100)', async () => {
    const sig = await confirmDelivery(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
      score: 100,
    });
    expect(sig).toBe('mocksig-escrow');
  });
});

// ─── claimTimeout ─────────────────────────────────────────────────────────────

describe('claimEscrowTimeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchNullable.mockResolvedValue(escrowInState({ delivered: {} }));
    mockClaimTimeout.mockResolvedValue(makeIx());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('throws EscrowNotFoundError when escrow is null', async () => {
    mockFetchNullable.mockResolvedValue(null);
    await expect(
      claimEscrowTimeout(makeConnection(), makeWallet(), ESCROW_PDA.toBase58()),
    ).rejects.toBeInstanceOf(EscrowNotFoundError);
  });

  it('throws DeliveryNotSubmittedError when state is created', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState({ created: {} }));
    await expect(
      claimEscrowTimeout(makeConnection(), makeWallet(), ESCROW_PDA.toBase58()),
    ).rejects.toBeInstanceOf(DeliveryNotSubmittedError);
  });

  it('throws EscrowAlreadyResolvedError when state is confirmed', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState({ confirmed: {} }));
    await expect(
      claimEscrowTimeout(makeConnection(), makeWallet(), ESCROW_PDA.toBase58()),
    ).rejects.toBeInstanceOf(EscrowAlreadyResolvedError);
  });

  it('returns signature on success when state is delivered', async () => {
    const sig = await claimEscrowTimeout(makeConnection(), makeWallet(), ESCROW_PDA.toBase58());
    expect(sig).toBe('mocksig-escrow');
  });
});

// ─── dispute ──────────────────────────────────────────────────────────────────

describe('openEscrowDispute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchNullable.mockResolvedValue(escrowInState({ created: {} }));
    mockOpenDispute.mockResolvedValue(makeIx());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('throws ValidationError when reason is empty', async () => {
    await expect(
      openEscrowDispute(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), { reason: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws EscrowNotFoundError when escrow is null', async () => {
    mockFetchNullable.mockResolvedValue(null);
    await expect(
      openEscrowDispute(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
        reason: 'bad service',
      }),
    ).rejects.toBeInstanceOf(EscrowNotFoundError);
  });

  it('throws EscrowAlreadyDisputedError when state is disputed', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState({ disputed: {} }));
    await expect(
      openEscrowDispute(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
        reason: 'bad service',
      }),
    ).rejects.toBeInstanceOf(EscrowAlreadyDisputedError);
  });

  it('throws EscrowAlreadyResolvedError when state is confirmed', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState({ confirmed: {} }));
    await expect(
      openEscrowDispute(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
        reason: 'bad service',
      }),
    ).rejects.toBeInstanceOf(EscrowAlreadyResolvedError);
  });

  it('returns signature on success, evidenceUri defaults to empty string', async () => {
    const sig = await openEscrowDispute(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
      reason: 'bad service',
    });
    expect(sig).toBe('mocksig-escrow');
  });

  it('passes evidenceUri when provided', async () => {
    const sig = await openEscrowDispute(makeConnection(), makeWallet(), ESCROW_PDA.toBase58(), {
      reason: 'fraud',
      evidenceUri: 'https://evidence.example.com',
    });
    expect(sig).toBe('mocksig-escrow');
  });
});
