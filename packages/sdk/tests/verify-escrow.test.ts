import { type Connection, Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorWallet } from '../src/client.js';

const mockFetchNullable = vi.fn();
vi.mock('@coral-xyz/anchor', () => {
  class AnchorProvider {}
  class Program {
    account = { escrowAccount: { fetchNullable: mockFetchNullable } };
  }
  return { AnchorProvider, Program };
});

const { verifyEscrow } = await import('../src/verify-escrow.js');

const ESCROW = new PublicKey('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd');
const SELLER = Keypair.generate().publicKey;
const LISTING = Keypair.generate().publicKey;
const BUYER = Keypair.generate().publicKey;
const OTHER = Keypair.generate().publicKey;

function makeWallet(): AnchorWallet {
  return {
    publicKey: Keypair.generate().publicKey,
    signTransaction: vi.fn(async (tx) => tx),
    signAllTransactions: vi.fn(async (txs) => txs),
  } as unknown as AnchorWallet;
}

function makeConnection(): Connection {
  return { rpcEndpoint: 'https://api.devnet.solana.com' } as Connection;
}

function escrowInState(stateKey: string) {
  return {
    state: { [stateKey]: {} },
    buyer: BUYER,
    seller: SELLER,
    listing: LISTING,
  };
}

describe('verifyEscrow', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('returns ok=false when pubkey is invalid', async () => {
    const result = await verifyEscrow(makeConnection(), makeWallet(), 'not-a-pubkey');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('invalid escrow pubkey') });
  });

  it('returns ok=false when escrow account does not exist', async () => {
    mockFetchNullable.mockResolvedValue(null);
    const result = await verifyEscrow(makeConnection(), makeWallet(), ESCROW.toBase58());
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('escrow not found') });
  });

  it('returns ok=true with parsed escrow when no expectations supplied', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState('created'));
    const result = await verifyEscrow(makeConnection(), makeWallet(), ESCROW.toBase58());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.escrow.state).toBe('created');
      expect(result.escrow.seller.equals(SELLER)).toBe(true);
      expect(result.escrow.listing.equals(LISTING)).toBe(true);
    }
  });

  it('returns ok=false when expectedListing does not match', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState('created'));
    const result = await verifyEscrow(makeConnection(), makeWallet(), ESCROW.toBase58(), {
      expectedListing: OTHER,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('listing mismatch') });
  });

  it('returns ok=false when expectedSeller does not match', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState('created'));
    const result = await verifyEscrow(makeConnection(), makeWallet(), ESCROW.toBase58(), {
      expectedSeller: OTHER,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('seller mismatch') });
  });

  it('returns ok=false when state does not match requireState', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState('delivered'));
    const result = await verifyEscrow(makeConnection(), makeWallet(), ESCROW.toBase58(), {
      requireState: 'created',
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('state mismatch') });
  });

  it('returns ok=true when all three expectations align', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState('created'));
    const result = await verifyEscrow(makeConnection(), makeWallet(), ESCROW.toBase58(), {
      expectedListing: LISTING,
      expectedSeller: SELLER,
      requireState: 'created',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts string-form pubkeys for expectedListing/expectedSeller', async () => {
    mockFetchNullable.mockResolvedValue(escrowInState('created'));
    const result = await verifyEscrow(makeConnection(), makeWallet(), ESCROW.toBase58(), {
      expectedListing: LISTING.toBase58(),
      expectedSeller: SELLER.toBase58(),
    });
    expect(result.ok).toBe(true);
  });
});
