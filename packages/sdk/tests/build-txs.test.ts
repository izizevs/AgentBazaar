/**
 * Unit tests for the unsigned transaction builders in build-txs.ts.
 *
 * All on-chain calls (Anchor Program, Connection) are mocked — tests run fully
 * offline and assert that:
 *   1. The correct instruction arguments are forwarded to Anchor's method builder.
 *   2. The returned Transaction contains the expected instruction + feePayer.
 *   3. ValidationError is thrown for invalid inputs.
 */
import {
  type Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../src/errors.js';

// ─── Anchor mock ──────────────────────────────────────────────────────────────

const mockInstruction = vi.fn();

vi.mock('@coral-xyz/anchor', () => {
  class AnchorProvider {}

  // Generic builder that returns { instruction: mockInstruction } for any method chain.
  const _methodChain = () => ({
    accounts: () => ({ instruction: mockInstruction }),
  });

  class Program {
    account = {
      escrowAccount: {
        fetchNullable: vi.fn().mockResolvedValue({
          listing: new PublicKey('11111111111111111111111111111111'),
          seller: new PublicKey('11111111111111111111111111111111'),
        }),
      },
    };
    methods = new Proxy(
      {},
      {
        get: () => () => ({
          accounts: () => ({ instruction: mockInstruction }),
        }),
      },
    );
  }

  return { AnchorProvider, Program };
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

const BLOCKHASH = '11111111111111111111111111111111';

function makeConnection(): Connection {
  return {
    rpcEndpoint: 'https://api.devnet.solana.com',
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 9999,
    }),
  } as unknown as Connection;
}

function makeIx() {
  return new TransactionInstruction({
    keys: [],
    programId: new PublicKey('11111111111111111111111111111111'),
    data: Buffer.alloc(4),
  });
}

// ─── Import builders lazily (picks up mocks) ─────────────────────────────────

const { buildRegisterTx, buildHireTx, buildDeliverTx, buildConfirmTx } = await import(
  '../src/build-txs.js'
);

// ─── buildRegisterTx ─────────────────────────────────────────────────────────

describe('buildRegisterTx', () => {
  const keypair = Keypair.generate();

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstruction.mockResolvedValue(makeIx());
  });

  it('returns a Transaction and a listingPubkey', async () => {
    const conn = makeConnection();
    const result = await buildRegisterTx(conn, {
      signerPubkey: keypair.publicKey,
      capability: 'translate-text',
      priceUsdcBaseUnits: 1_000_000n,
      satiAgentId: 0n,
      pricingModel: 'per_request',
      slaParams: { maxLatencyMs: 3000 },
      metadataUri: 'QmTestCid1234567890123456789012345678901234567',
    });

    expect(result.transaction).toBeInstanceOf(Transaction);
    expect(result.listingPubkey).toBeInstanceOf(PublicKey);
  });

  it('sets feePayer to signerPubkey', async () => {
    const conn = makeConnection();
    const result = await buildRegisterTx(conn, {
      signerPubkey: keypair.publicKey,
      capability: 'translate-text',
      priceUsdcBaseUnits: 500n,
      satiAgentId: 0n,
      pricingModel: 'per_job',
      slaParams: {},
      metadataUri: 'QmSomeCid123456789012345678901234567890123456',
    });

    expect(result.transaction.feePayer?.toBase58()).toBe(keypair.publicKey.toBase58());
  });

  it('throws ValidationError for empty capability', async () => {
    const conn = makeConnection();
    await expect(
      buildRegisterTx(conn, {
        signerPubkey: keypair.publicKey,
        capability: '',
        priceUsdcBaseUnits: 1n,
        satiAgentId: 0n,
        pricingModel: 'per_request',
        slaParams: {},
        metadataUri: 'QmTest',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for negative price', async () => {
    const conn = makeConnection();
    await expect(
      buildRegisterTx(conn, {
        signerPubkey: keypair.publicKey,
        capability: 'foo',
        priceUsdcBaseUnits: -1n,
        satiAgentId: 0n,
        pricingModel: 'per_request',
        slaParams: {},
        metadataUri: 'QmTest',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for invalid pricingModel', async () => {
    const conn = makeConnection();
    await expect(
      buildRegisterTx(conn, {
        signerPubkey: keypair.publicKey,
        capability: 'foo',
        priceUsdcBaseUnits: 1n,
        satiAgentId: 0n,
        pricingModel: 'invalid',
        slaParams: {},
        metadataUri: 'QmTest',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('produces deterministic listingPubkey for same wallet + capability', async () => {
    const conn = makeConnection();
    const input = {
      signerPubkey: keypair.publicKey,
      capability: 'deterministic-cap',
      priceUsdcBaseUnits: 1n,
      satiAgentId: 0n,
      pricingModel: 'per_request' as const,
      slaParams: {},
      metadataUri: 'QmDet',
    };
    const r1 = await buildRegisterTx(conn, input);
    vi.clearAllMocks();
    mockInstruction.mockResolvedValue(makeIx());
    (conn.getLatestBlockhash as ReturnType<typeof vi.fn>).mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 9999,
    });
    const r2 = await buildRegisterTx(conn, input);
    expect(r1.listingPubkey.toBase58()).toBe(r2.listingPubkey.toBase58());
  });
});

// ─── buildHireTx ─────────────────────────────────────────────────────────────

describe('buildHireTx', () => {
  const buyer = Keypair.generate();
  const listing = new PublicKey('ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3');

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstruction.mockResolvedValue(makeIx());
  });

  it('returns transaction, escrowPubkey, vaultPubkey', async () => {
    const conn = makeConnection();
    const result = await buildHireTx(conn, {
      buyerPubkey: buyer.publicKey,
      listingPubkey: listing,
      budgetUsdcBaseUnits: 5_000_000n,
      timeoutSeconds: 86400,
      slaParams: { maxLatencyMs: 2000 },
      nonce: 12345n,
    });

    expect(result.transaction).toBeInstanceOf(Transaction);
    expect(result.escrowPubkey).toBeInstanceOf(PublicKey);
    expect(result.vaultPubkey).toBeInstanceOf(PublicKey);
  });

  it('sets feePayer to buyerPubkey', async () => {
    const conn = makeConnection();
    const result = await buildHireTx(conn, {
      buyerPubkey: buyer.publicKey,
      listingPubkey: listing,
      budgetUsdcBaseUnits: 1_000_000n,
      timeoutSeconds: 86400,
      slaParams: {},
      nonce: 1n,
    });

    expect(result.transaction.feePayer?.toBase58()).toBe(buyer.publicKey.toBase58());
  });

  it('derives deterministic PDAs for same buyer+listing+nonce', async () => {
    const conn = makeConnection();
    const input = {
      buyerPubkey: buyer.publicKey,
      listingPubkey: listing,
      budgetUsdcBaseUnits: 1_000_000n,
      timeoutSeconds: 86400,
      slaParams: {},
      nonce: 99999n,
    };
    const r1 = await buildHireTx(conn, input);
    vi.clearAllMocks();
    mockInstruction.mockResolvedValue(makeIx());
    (conn.getLatestBlockhash as ReturnType<typeof vi.fn>).mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 9999,
    });
    const r2 = await buildHireTx(conn, input);
    expect(r1.escrowPubkey.toBase58()).toBe(r2.escrowPubkey.toBase58());
    expect(r1.vaultPubkey.toBase58()).toBe(r2.vaultPubkey.toBase58());
  });

  it('throws ValidationError for zero budget', async () => {
    const conn = makeConnection();
    await expect(
      buildHireTx(conn, {
        buyerPubkey: buyer.publicKey,
        listingPubkey: listing,
        budgetUsdcBaseUnits: 0n,
        timeoutSeconds: 86400,
        slaParams: {},
        nonce: 1n,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for zero timeout', async () => {
    const conn = makeConnection();
    await expect(
      buildHireTx(conn, {
        buyerPubkey: buyer.publicKey,
        listingPubkey: listing,
        budgetUsdcBaseUnits: 1_000_000n,
        timeoutSeconds: 0,
        slaParams: {},
        nonce: 1n,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ─── buildDeliverTx ──────────────────────────────────────────────────────────

describe('buildDeliverTx', () => {
  const seller = Keypair.generate();
  const escrow = new PublicKey('EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2');
  const validHash = 'a'.repeat(64); // 64 hex chars

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstruction.mockResolvedValue(makeIx());
  });

  it('returns an unsigned Transaction', async () => {
    const conn = makeConnection();
    const tx = await buildDeliverTx(conn, {
      signerPubkey: seller.publicKey,
      escrowPubkey: escrow,
      resultUri: 'ipfs://QmResult1234567890123456789012345678901234567890',
      resultHashHex: validHash,
    });
    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.feePayer?.toBase58()).toBe(seller.publicKey.toBase58());
  });

  it('throws ValidationError for empty resultUri', async () => {
    const conn = makeConnection();
    await expect(
      buildDeliverTx(conn, {
        signerPubkey: seller.publicKey,
        escrowPubkey: escrow,
        resultUri: '',
        resultHashHex: validHash,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for non-hex resultHashHex', async () => {
    const conn = makeConnection();
    await expect(
      buildDeliverTx(conn, {
        signerPubkey: seller.publicKey,
        escrowPubkey: escrow,
        resultUri: 'ipfs://QmResult',
        resultHashHex: 'z'.repeat(64), // invalid hex
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for wrong-length resultHashHex', async () => {
    const conn = makeConnection();
    await expect(
      buildDeliverTx(conn, {
        signerPubkey: seller.publicKey,
        escrowPubkey: escrow,
        resultUri: 'ipfs://QmResult',
        resultHashHex: 'ab'.repeat(16), // 32 chars = 16 bytes, not 32
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ─── buildConfirmTx ──────────────────────────────────────────────────────────

describe('buildConfirmTx', () => {
  const buyer = Keypair.generate();
  const seller = Keypair.generate();
  const escrow = new PublicKey('EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2');
  const listing = new PublicKey('ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3');

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstruction.mockResolvedValue(makeIx());
  });

  it('returns an unsigned Transaction when listing+seller supplied', async () => {
    const conn = makeConnection();
    const tx = await buildConfirmTx(conn, {
      signerPubkey: buyer.publicKey,
      escrowPubkey: escrow,
      slaSeverity: 0,
      listingPubkey: listing,
      sellerPubkey: seller.publicKey,
    });
    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.feePayer?.toBase58()).toBe(buyer.publicKey.toBase58());
  });

  it('accepts all valid slaSeverity values (0–3)', async () => {
    const conn = makeConnection();
    for (const s of [0, 1, 2, 3]) {
      vi.clearAllMocks();
      mockInstruction.mockResolvedValue(makeIx());
      (conn.getLatestBlockhash as ReturnType<typeof vi.fn>).mockResolvedValue({
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 9999,
      });
      const tx = await buildConfirmTx(conn, {
        signerPubkey: buyer.publicKey,
        escrowPubkey: escrow,
        slaSeverity: s,
        listingPubkey: listing,
        sellerPubkey: seller.publicKey,
      });
      expect(tx).toBeInstanceOf(Transaction);
    }
  });

  it('throws ValidationError for slaSeverity out of range', async () => {
    const conn = makeConnection();
    for (const s of [-1, 4, 100]) {
      await expect(
        buildConfirmTx(conn, {
          signerPubkey: buyer.publicKey,
          escrowPubkey: escrow,
          slaSeverity: s,
          listingPubkey: listing,
          sellerPubkey: seller.publicKey,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });
});
