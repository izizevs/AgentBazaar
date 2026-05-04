/**
 * Unit tests for MCP write tools (register, hire, deliver, confirm).
 *
 * The SDK buildTx functions are mocked so tests are fully offline.
 * Asserts:
 *   - Correct MCP response shape (content[0].type === 'text')
 *   - Base64 transaction is present in the JSON payload
 *   - Metadata fields are correct
 *   - Input validation errors surface as MCP error responses (isError: true)
 */
import { buildConfirmTx, buildDeliverTx, buildHireTx, buildRegisterTx } from '@agent-bazaar/sdk';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock @agent-bazaar/sdk buildTx functions ──────────────────────────────────
// Note: vi.mock factories are hoisted; they MUST NOT reference module-level
// variables declared after the mock call. Use inline values only.

vi.mock('@agent-bazaar/sdk', () => ({
  buildRegisterTx: vi.fn(),
  buildHireTx: vi.fn(),
  buildDeliverTx: vi.fn(),
  buildConfirmTx: vi.fn(),
  ValidationError: class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ValidationError';
    }
  },
}));

// ─── Mock @solana/web3.js Connection ─────────────────────────────────────────

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class MockConnection {
      rpcEndpoint = 'https://api.devnet.solana.com';
    },
  };
});

// ─── Shared test fixtures ─────────────────────────────────────────────────────

const FAKE_LISTING = new PublicKey('ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3');
const FAKE_ESCROW = new PublicKey('EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2');
const FAKE_VAULT = new PublicKey('26rhkrBkf75ijDoDuhed8m94FkuhB2MukvqtWYEDegd8');

function makeTx(): Transaction {
  const tx = new Transaction();
  tx.feePayer = FAKE_LISTING;
  tx.add(
    new TransactionInstruction({
      keys: [],
      programId: new PublicKey('11111111111111111111111111111111'),
      data: Buffer.alloc(4),
    }),
  );
  tx.recentBlockhash = '11111111111111111111111111111111';
  return tx;
}

// ─── Import tools lazily after mocks ──────────────────────────────────────────

const { registerTool } = await import('../src/tools/register.js');
const { hireTool } = await import('../src/tools/hire.js');
const { deliverTool } = await import('../src/tools/deliver.js');
const { confirmTool } = await import('../src/tools/confirm.js');

const RPC = 'https://api.devnet.solana.com';
const SIGNER = 'ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3';
const ESCROW_PUBKEY = 'EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2';
const LISTING_PUBKEY = 'ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3';

// ─── Default mock return values (reset before each describe) ──────────────────

function resetMocks() {
  vi.mocked(buildRegisterTx).mockResolvedValue({
    transaction: makeTx(),
    listingPubkey: FAKE_LISTING,
  });
  vi.mocked(buildHireTx).mockResolvedValue({
    transaction: makeTx(),
    escrowPubkey: FAKE_ESCROW,
    vaultPubkey: FAKE_VAULT,
  });
  vi.mocked(buildDeliverTx).mockResolvedValue(makeTx());
  vi.mocked(buildConfirmTx).mockResolvedValue(makeTx());
}

// ─── bazaar_register ─────────────────────────────────────────────────────────

describe('registerTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('returns MCP content with base64 transaction', async () => {
    const result = await registerTool(
      {
        signerPubkey: SIGNER,
        capability: 'translate-text',
        priceUsdcBaseUnits: 1_000_000n,
        satiAgentId: 0n,
        pricingModel: 'per_request',
        slaParams: { maxLatencyMs: 3000 },
        metadataUri: 'QmTestCid1234567890123456789012345678901234567',
      },
      RPC,
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');

    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.success).toBe(true);
    expect(typeof parsed.transaction).toBe('string');
    expect(parsed.transaction.length).toBeGreaterThan(0);
    expect(parsed.metadata.expectedListingPubkey).toBe(FAKE_LISTING.toBase58());
  });

  it('includes signerPubkey and capability in metadata', async () => {
    const result = await registerTool(
      {
        signerPubkey: SIGNER,
        capability: 'code-review',
        priceUsdcBaseUnits: 500_000n,
        satiAgentId: 0n,
        pricingModel: 'per_job',
        slaParams: {},
        metadataUri: 'QmSomeCid',
      },
      RPC,
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.metadata.signerPubkey).toBe(SIGNER);
    expect(parsed.metadata.capability).toBe('code-review');
  });

  it('returns isError response when buildRegisterTx throws', async () => {
    vi.mocked(buildRegisterTx).mockRejectedValueOnce(new Error('capability must not be empty'));

    const result = await registerTool(
      {
        signerPubkey: SIGNER,
        capability: 'something',
        priceUsdcBaseUnits: 1n,
        satiAgentId: 0n,
        pricingModel: 'per_request',
        slaParams: {},
        metadataUri: 'Qm',
      },
      RPC,
    );

    expect(result.content[0]?.text).toContain('error');
  });
});

// ─── bazaar_hire ─────────────────────────────────────────────────────────────

describe('hireTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('returns base64 transaction with escrow and vault pubkeys', async () => {
    const result = await hireTool(
      {
        buyerPubkey: SIGNER,
        listingPubkey: LISTING_PUBKEY,
        budgetUsdcBaseUnits: 5_000_000n,
        timeoutSeconds: 86400,
        slaTerms: { maxLatencyMs: 2000 },
        nonce: 12345n,
      },
      RPC,
    );

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.success).toBe(true);
    expect(typeof parsed.transaction).toBe('string');
    expect(parsed.metadata.expectedEscrowPubkey).toBe(FAKE_ESCROW.toBase58());
    expect(parsed.metadata.expectedVaultPubkey).toBe(FAKE_VAULT.toBase58());
  });

  it('generates a nonce when not provided', async () => {
    const result = await hireTool(
      {
        buyerPubkey: SIGNER,
        listingPubkey: LISTING_PUBKEY,
        budgetUsdcBaseUnits: 1_000_000n,
        timeoutSeconds: 172800,
      },
      RPC,
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(typeof parsed.metadata.nonce).toBe('string');
    expect(Number(parsed.metadata.nonce)).toBeGreaterThan(0);
  });

  it('returns isError on buildHireTx failure', async () => {
    vi.mocked(buildHireTx).mockRejectedValueOnce(new Error('budget must be positive'));

    const result = await hireTool(
      {
        buyerPubkey: SIGNER,
        listingPubkey: LISTING_PUBKEY,
        budgetUsdcBaseUnits: 1_000_000n,
        timeoutSeconds: 86400,
      },
      RPC,
    );

    expect(result.content[0]?.text).toContain('error');
  });
});

// ─── bazaar_deliver ──────────────────────────────────────────────────────────

describe('deliverTool', () => {
  const VALID_HASH = 'a'.repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('returns base64 transaction with delivery metadata', async () => {
    const result = await deliverTool(
      {
        signerPubkey: SIGNER,
        escrowPubkey: ESCROW_PUBKEY,
        resultUri: 'ipfs://QmResult123456789012345678901234567890',
        resultHashHex: VALID_HASH,
      },
      RPC,
    );

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.success).toBe(true);
    expect(typeof parsed.transaction).toBe('string');
    expect(parsed.metadata.resultUri).toBe('ipfs://QmResult123456789012345678901234567890');
    expect(parsed.metadata.resultHashHex).toBe(VALID_HASH);
  });

  it('returns isError on buildDeliverTx failure', async () => {
    vi.mocked(buildDeliverTx).mockRejectedValueOnce(new Error('resultUri must not be empty'));

    const result = await deliverTool(
      {
        signerPubkey: SIGNER,
        escrowPubkey: ESCROW_PUBKEY,
        resultUri: 'ipfs://Qm',
        resultHashHex: VALID_HASH,
      },
      RPC,
    );

    expect(result.content[0]?.text).toContain('error');
  });
});

// ─── bazaar_confirm ──────────────────────────────────────────────────────────

describe('confirmTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('returns base64 transaction with slaSeverity metadata', async () => {
    const result = await confirmTool(
      {
        signerPubkey: SIGNER,
        escrowPubkey: ESCROW_PUBKEY,
        slaSeverity: 0,
      },
      RPC,
    );

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed.success).toBe(true);
    expect(typeof parsed.transaction).toBe('string');
    expect(parsed.metadata.slaSeverity).toBe(0);
    expect(parsed.metadata.reputationScore).toBe(100);
  });

  it('maps slaSeverity to correct reputation score', async () => {
    const expected: Record<number, number> = { 0: 100, 1: 75, 2: 50, 3: 25 };
    for (const [severity, score] of Object.entries(expected)) {
      vi.clearAllMocks();
      resetMocks();
      const result = await confirmTool(
        {
          signerPubkey: SIGNER,
          escrowPubkey: ESCROW_PUBKEY,
          slaSeverity: Number(severity),
        },
        RPC,
      );
      const parsed = JSON.parse(result.content[0]?.text ?? '{}');
      expect(parsed.metadata.reputationScore).toBe(score);
    }
  });

  it('returns isError on buildConfirmTx failure', async () => {
    vi.mocked(buildConfirmTx).mockRejectedValueOnce(new Error('Escrow not found'));

    const result = await confirmTool(
      {
        signerPubkey: SIGNER,
        escrowPubkey: ESCROW_PUBKEY,
        slaSeverity: 1,
      },
      RPC,
    );

    expect(result.content[0]?.text).toContain('error');
  });
});

// ─── E2E-style test: register → hire → deliver → confirm chain ───────────────

describe('A2A flow (offline): register → hire → deliver → confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it('produces base64 txs for all 4 stages', async () => {
    const registerResult = await registerTool(
      {
        signerPubkey: SIGNER,
        capability: 'e2e-test-service',
        priceUsdcBaseUnits: 1_000_000n,
        satiAgentId: 0n,
        pricingModel: 'per_request',
        slaParams: { maxLatencyMs: 5000 },
        metadataUri: 'QmE2ETest123456789012345678901234567890123456',
      },
      RPC,
    );
    const reg = JSON.parse(registerResult.content[0]?.text ?? '{}');
    expect(reg.success).toBe(true);
    expect(typeof reg.transaction).toBe('string');

    const hireResult = await hireTool(
      {
        buyerPubkey: SIGNER,
        listingPubkey: reg.metadata.expectedListingPubkey,
        budgetUsdcBaseUnits: 1_000_000n,
        timeoutSeconds: 86400,
        nonce: 42n,
      },
      RPC,
    );
    const hire = JSON.parse(hireResult.content[0]?.text ?? '{}');
    expect(hire.success).toBe(true);
    expect(typeof hire.transaction).toBe('string');

    const deliverResult = await deliverTool(
      {
        signerPubkey: SIGNER,
        escrowPubkey: hire.metadata.expectedEscrowPubkey,
        resultUri: 'ipfs://QmDelivery',
        resultHashHex: 'b'.repeat(64),
      },
      RPC,
    );
    const deliver = JSON.parse(deliverResult.content[0]?.text ?? '{}');
    expect(deliver.success).toBe(true);

    const confirmResult = await confirmTool(
      {
        signerPubkey: SIGNER,
        escrowPubkey: hire.metadata.expectedEscrowPubkey,
        slaSeverity: 0,
      },
      RPC,
    );
    const confirm = JSON.parse(confirmResult.content[0]?.text ?? '{}');
    expect(confirm.success).toBe(true);
    expect(confirm.metadata.reputationScore).toBe(100);
  });
});
