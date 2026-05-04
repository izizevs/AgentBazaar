import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { AnchorWallet } from './client.js';
import { makeEscrowProgram } from './escrow-utils.js';

/**
 * The four EscrowState variants emitted by the bazaar-escrow program.
 * The on-chain account stores them as `{ created: {} }`, `{ delivered: {} }`, etc.
 */
export type EscrowState = 'created' | 'delivered' | 'confirmed' | 'timeoutClaimed' | 'disputed';

const STATE_KEYS: readonly EscrowState[] = [
  'created',
  'delivered',
  'confirmed',
  'timeoutClaimed',
  'disputed',
];

export interface VerifyEscrowOptions {
  /** If set, the escrow's on-chain `listing` field must equal this pubkey. */
  expectedListing?: PublicKey | string;
  /** If set, the escrow's on-chain `seller` field must equal this pubkey. */
  expectedSeller?: PublicKey | string;
  /** If set, the escrow must currently be in this state. */
  requireState?: EscrowState;
}

export interface VerifyEscrowOk {
  ok: true;
  escrow: {
    pubkey: PublicKey;
    buyer: PublicKey;
    seller: PublicKey;
    listing: PublicKey;
    state: EscrowState;
  };
}

export interface VerifyEscrowFailure {
  ok: false;
  reason: string;
}

export type VerifyEscrowResult = VerifyEscrowOk | VerifyEscrowFailure;

function readState(escrow: { state: Record<string, unknown> }): EscrowState | null {
  for (const key of STATE_KEYS) {
    if (key in escrow.state) return key;
  }
  return null;
}

function toPubkey(value: PublicKey | string): PublicKey {
  return typeof value === 'string' ? new PublicKey(value) : value;
}

/**
 * Inspect an on-chain escrow and validate it matches expected provider/listing/state.
 *
 * Intended for service providers receiving a buyer's request: cheaply confirm
 * the escrow is real, belongs to your listing, names you as the seller, and is
 * still in the expected state — BEFORE doing any work.
 *
 * Returns a discriminated result rather than throwing so callers can compose it
 * into HTTP error responses without try/catch ceremony.
 */
export async function verifyEscrow(
  connection: Connection,
  wallet: AnchorWallet,
  escrowId: PublicKey | string,
  options: VerifyEscrowOptions = {},
): Promise<VerifyEscrowResult> {
  let escrowPda: PublicKey;
  try {
    escrowPda = toPubkey(escrowId);
  } catch {
    return { ok: false, reason: `invalid escrow pubkey: ${String(escrowId)}` };
  }

  const program = makeEscrowProgram(connection, wallet);
  // biome-ignore lint/suspicious/noExplicitAny: Anchor account fetch returns generic structure
  const raw = (await program.account.escrowAccount.fetchNullable(escrowPda)) as any;
  if (!raw) {
    return { ok: false, reason: `escrow not found on-chain: ${escrowPda.toBase58()}` };
  }

  const state = readState(raw);
  if (!state) {
    return { ok: false, reason: 'escrow account has unknown state' };
  }

  const buyer = raw.buyer as PublicKey;
  const seller = raw.seller as PublicKey;
  const listing = raw.listing as PublicKey;

  if (options.expectedListing) {
    const expected = toPubkey(options.expectedListing);
    if (!listing.equals(expected)) {
      return {
        ok: false,
        reason: `listing mismatch: expected ${expected.toBase58()}, got ${listing.toBase58()}`,
      };
    }
  }

  if (options.expectedSeller) {
    const expected = toPubkey(options.expectedSeller);
    if (!seller.equals(expected)) {
      return {
        ok: false,
        reason: `seller mismatch: expected ${expected.toBase58()}, got ${seller.toBase58()}`,
      };
    }
  }

  if (options.requireState && state !== options.requireState) {
    return {
      ok: false,
      reason: `state mismatch: expected ${options.requireState}, got ${state}`,
    };
  }

  return {
    ok: true,
    escrow: { pubkey: escrowPda, buyer, seller, listing, state },
  };
}
