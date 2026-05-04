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
  DuplicateListingError,
  MetadataUploadError,
  NotImplementedError,
  TransactionFailedError,
  ValidationError,
} from '../src/errors.js';
import type { RegisterInput } from '../src/types.js';

// ─── mocks ────────────────────────────────────────────────────────────────────

// Mutable mock program state — reset each test
const mockFetchNullable = vi.fn();
const mockInstruction = vi.fn();

vi.mock('@coral-xyz/anchor', () => {
  class AnchorProvider {}

  class Program {
    account = {
      serviceListing: { fetchNullable: mockFetchNullable },
    };
    methods = {
      registerService: () => ({
        accounts: () => ({
          instruction: mockInstruction,
        }),
      }),
    };
  }

  return { AnchorProvider, Program };
});

// Mock global fetch for Pinata — stubbed per-test in beforeEach (afterEach calls vi.unstubAllGlobals)
const mockFetch = vi.fn();

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
  // Cast via unknown to satisfy AnchorWallet's generic constraints while preserving mock methods.
  return mock as unknown as typeof mock & AnchorWallet;
}

// '11111111111111111111111111111111' = 32 zero bytes in base58 — valid for serialize()
const MOCK_BLOCKHASH = '11111111111111111111111111111111';

function makeConnection() {
  return {
    rpcEndpoint: 'https://api.devnet.solana.com',
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: MOCK_BLOCKHASH,
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: vi.fn().mockResolvedValue('mocksig1234'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  } as unknown as Connection;
}

function validInput(): RegisterInput {
  return {
    name: 'My Agent',
    description: 'Does useful things',
    capability: 'text-summarization',
    priceUsdc: 1_000_000n,
    pricingModel: 'per_request',
    sla: { maxLatencyMs: 2000 },
    endpoint: 'https://agent.example.com',
  };
}

function mockPinataSuccess(cid = 'QmTestCid1234567890AAAAAAAAAAAAAAAAAAAAAAAAA') {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { cid } }),
  });
}

const PINATA_JWT = 'test-pinata-jwt';

// ─── import registerService lazily to pick up mocks ──────────────────────────

const { registerService } = await import('../src/register.js');

// ─── suite ───────────────────────────────────────────────────────────────────

describe('registerService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    vi.clearAllMocks();
    // Default: no existing listing
    mockFetchNullable.mockResolvedValue(null);
    // Default: instruction builds ok
    mockInstruction.mockResolvedValue(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey('11111111111111111111111111111111'),
        data: Buffer.alloc(0),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── input validation ───────────────────────────────────────────────────────

  it('throws ValidationError when name is empty', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    const input = { ...validInput(), name: '' };

    await expect(registerService(conn, wallet, input, PINATA_JWT)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('throws ValidationError when capability is empty', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    const input = { ...validInput(), capability: '' };

    await expect(registerService(conn, wallet, input, PINATA_JWT)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('throws ValidationError when avatar is non-https', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    const input = { ...validInput(), avatar: 'http://insecure.example.com/img.png' };

    await expect(registerService(conn, wallet, input, PINATA_JWT)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('throws ValidationError when name exceeds 64 chars', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    const input = { ...validInput(), name: 'x'.repeat(65) };

    await expect(registerService(conn, wallet, input, PINATA_JWT)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('throws ValidationError when endpoint uses non-https scheme', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();

    for (const endpoint of ['javascript:alert(1)', 'http://agent.example.com', 'ftp://x.com']) {
      await expect(
        registerService(conn, wallet, { ...validInput(), endpoint }, PINATA_JWT),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('throws ValidationError when priceUsdc is negative', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    const input = { ...validInput(), priceUsdc: -1n };

    await expect(registerService(conn, wallet, input, PINATA_JWT)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('throws ValidationError when priceUsdc exceeds u64 max', async () => {
    const wallet = makeWallet();
    const conn = makeConnection();
    const input = { ...validInput(), priceUsdc: 2n ** 64n };

    await expect(registerService(conn, wallet, input, PINATA_JWT)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  // ─── duplicate listing guard ────────────────────────────────────────────────

  it('throws DuplicateListingError when active listing exists', async () => {
    mockFetchNullable.mockResolvedValue({ isActive: true });
    mockPinataSuccess(); // shouldn't be reached, but harmless to set up

    const wallet = makeWallet();
    const conn = makeConnection();

    await expect(registerService(conn, wallet, validInput(), PINATA_JWT)).rejects.toBeInstanceOf(
      DuplicateListingError,
    );
  });

  it('does not throw when listing exists but is inactive', async () => {
    mockFetchNullable.mockResolvedValue({ isActive: false });
    mockPinataSuccess();

    const wallet = makeWallet();
    const conn = makeConnection();

    const result = await registerService(conn, wallet, validInput(), PINATA_JWT);
    expect(result.signature).toBe('mocksig1234');
  });

  // ─── Pinata upload ──────────────────────────────────────────────────────────

  it("uploads to Pinata's 'public' network so the indexer can fetch via gateway.pinata.cloud", async () => {
    mockPinataSuccess();
    const wallet = makeWallet();
    const conn = makeConnection();

    await registerService(conn, wallet, validInput(), PINATA_JWT);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const form = opts.body as FormData;
    expect(form.get('network')).toBe('public');
  });

  it('throws MetadataUploadError when Pinata returns non-ok status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const wallet = makeWallet();
    const conn = makeConnection();

    await expect(registerService(conn, wallet, validInput(), PINATA_JWT)).rejects.toBeInstanceOf(
      MetadataUploadError,
    );
  });

  it('throws MetadataUploadError when Pinata response lacks cid', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    });

    const wallet = makeWallet();
    const conn = makeConnection();

    await expect(registerService(conn, wallet, validInput(), PINATA_JWT)).rejects.toBeInstanceOf(
      MetadataUploadError,
    );
  });

  it('throws MetadataUploadError when CID exceeds 64 chars', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { cid: 'b'.repeat(65) } }),
    });

    const wallet = makeWallet();
    const conn = makeConnection();

    await expect(registerService(conn, wallet, validInput(), PINATA_JWT)).rejects.toBeInstanceOf(
      MetadataUploadError,
    );
  });

  it('sends Authorization Bearer header with pinataJwt', async () => {
    mockPinataSuccess();
    const wallet = makeWallet();
    const conn = makeConnection();

    await registerService(conn, wallet, validInput(), 'my-secret-jwt');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer my-secret-jwt');
  });

  // ─── success path ───────────────────────────────────────────────────────────

  it('returns listing PublicKey and signature on success', async () => {
    mockPinataSuccess();
    const wallet = makeWallet();
    const conn = makeConnection();

    const result = await registerService(conn, wallet, validInput(), PINATA_JWT);

    expect(result.listing).toBeInstanceOf(PublicKey);
    expect(typeof result.signature).toBe('string');
    expect(result.signature).toBe('mocksig1234');
  });

  it('calls signTransaction on the wallet', async () => {
    mockPinataSuccess();
    const wallet = makeWallet();
    const conn = makeConnection();

    await registerService(conn, wallet, validInput(), PINATA_JWT);

    expect(wallet.signTransaction).toHaveBeenCalledOnce();
  });

  it('includes endpoint in the metadata JSON uploaded to Pinata', async () => {
    mockPinataSuccess();
    const wallet = makeWallet();
    const conn = makeConnection();
    const input = { ...validInput(), endpoint: 'https://my-agent.io/v1' };

    await registerService(conn, wallet, input, PINATA_JWT);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const form = opts.body as FormData;
    const file = form.get('file') as Blob;
    const text = await file.text();
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload.endpoint).toBe('https://my-agent.io/v1');
  });

  it('derives a deterministic listing PDA for the same wallet + capability', async () => {
    mockPinataSuccess();
    const keypair = Keypair.generate();
    const wallet1 = makeWallet(keypair);
    const wallet2 = makeWallet(keypair);
    const conn = makeConnection();

    const r1 = await registerService(conn, wallet1, validInput(), PINATA_JWT);

    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetchNullable.mockResolvedValue(null);
    mockInstruction.mockResolvedValue(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey('11111111111111111111111111111111'),
        data: Buffer.alloc(0),
      }),
    );
    mockPinataSuccess();
    (conn.getLatestBlockhash as ReturnType<typeof vi.fn>).mockResolvedValue({
      blockhash: MOCK_BLOCKHASH,
      lastValidBlockHeight: 100,
    });
    (conn.sendRawTransaction as ReturnType<typeof vi.fn>).mockResolvedValue('mocksig1234');
    (conn.confirmTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { err: null },
    });

    const r2 = await registerService(conn, wallet2, validInput(), PINATA_JWT);

    expect(r1.listing.toBase58()).toBe(r2.listing.toBase58());
  });

  // ─── retry + priority fee escalation ───────────────────────────────────────

  it('retries on transaction failure and returns on second attempt', async () => {
    mockPinataSuccess();
    const wallet = makeWallet();
    const conn = makeConnection();

    // Fail first attempt, succeed on second
    (conn.sendRawTransaction as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('blockhash expired'))
      .mockResolvedValue('sig-retry');

    const result = await registerService(conn, wallet, validInput(), PINATA_JWT);
    expect(result.signature).toBe('sig-retry');
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it('throws TransactionFailedError after all 3 attempts fail', async () => {
    mockPinataSuccess();
    const wallet = makeWallet();
    const conn = makeConnection();

    (conn.sendRawTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('network error'),
    );

    await expect(registerService(conn, wallet, validInput(), PINATA_JWT)).rejects.toBeInstanceOf(
      TransactionFailedError,
    );
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(3);
  });

  it('escalates priority fees on successive retries', async () => {
    mockPinataSuccess();
    const keypair = Keypair.generate();
    const wallet = makeWallet(keypair);
    const conn = makeConnection();

    // Track what transactions are signed so we can inspect compute budget ixs
    const signedTxs: Transaction[] = [];
    wallet.signTransaction.mockImplementation(async (tx: Transaction) => {
      signedTxs.push(tx);
      tx.sign(keypair);
      return tx;
    });

    // Fail all attempts to see all retries
    (conn.sendRawTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('always fails'),
    );

    await expect(registerService(conn, wallet, validInput(), PINATA_JWT)).rejects.toBeInstanceOf(
      TransactionFailedError,
    );

    expect(wallet.signTransaction).toHaveBeenCalledTimes(3);

    // First attempt: no ComputeBudget instruction
    const ix0 = signedTxs[0]?.instructions ?? [];
    const hasCuIx0 = ix0.some((ix) =>
      ix.programId.equals(new PublicKey('ComputeBudget111111111111111111111111111111')),
    );
    expect(hasCuIx0).toBe(false);

    // Second attempt: ComputeBudget instruction present
    const ix1 = signedTxs[1]?.instructions ?? [];
    const hasCuIx1 = ix1.some((ix) =>
      ix.programId.equals(new PublicKey('ComputeBudget111111111111111111111111111111')),
    );
    expect(hasCuIx1).toBe(true);
  });

  // ─── on-chain revert detection (M2) ────────────────────────────────────────

  it('throws TransactionFailedError when confirmTransaction reports value.err', async () => {
    mockPinataSuccess();
    const wallet = makeWallet();
    const conn = makeConnection();

    (conn.confirmTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: { err: { Custom: 6002 } },
    });

    await expect(registerService(conn, wallet, validInput(), PINATA_JWT)).rejects.toBeInstanceOf(
      TransactionFailedError,
    );
  });

  it('retries after on-chain revert and returns on clean second attempt', async () => {
    mockPinataSuccess();
    const wallet = makeWallet();
    const conn = makeConnection();

    (conn.confirmTransaction as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ value: { err: { Custom: 6001 } } })
      .mockResolvedValue({ value: { err: null } });
    (conn.sendRawTransaction as ReturnType<typeof vi.fn>).mockResolvedValue('sig-revert-retry');

    const result = await registerService(conn, wallet, validInput(), PINATA_JWT);
    expect(result.signature).toBe('sig-revert-retry');
    expect(conn.confirmTransaction).toHaveBeenCalledTimes(2);
  });

  // ─── AgentBazaar client integration ─────────────────────────────────────────

  it('AgentBazaar.register() throws NotImplementedError when pinataJwt not configured', async () => {
    const { AgentBazaar } = await import('../src/client.js');
    const client = new AgentBazaar({
      wallet: makeWallet(),
      rpc: 'https://api.devnet.solana.com',
    });

    await expect(client.register(validInput())).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('AgentBazaar pinataJwt is not enumerable (does not appear in JSON.stringify)', async () => {
    const { AgentBazaar } = await import('../src/client.js');
    const client = new AgentBazaar({
      wallet: makeWallet(),
      rpc: 'https://api.devnet.solana.com',
      pinataJwt: 'super-secret-jwt',
    });

    const serialized = JSON.stringify(client);
    expect(serialized).not.toContain('super-secret-jwt');
    expect(serialized).not.toContain('pinataJwt');
  });
});
