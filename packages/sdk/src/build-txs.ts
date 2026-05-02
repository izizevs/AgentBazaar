/**
 * Unsigned transaction builders — sign-tx-on-client pattern.
 *
 * Each function constructs and returns an unsigned `Transaction` ready for
 * serialisation and delivery to an external signer (Phantom, file keypair,
 * Mobile Wallet Adapter, etc.).  No wallet.signTransaction() is called here.
 *
 * Pattern:
 *   1. MCP / API calls buildXxxTx(connection, signerPubkey, ...)
 *   2. Caller serialises: tx.serialize({ requireAllSignatures: false })
 *   3. Client signs + broadcasts; the chain has the final record.
 */

import type { BazaarRegistry } from '@agentbazaar/idl';
import { BazaarRegistryIDL, computeCapabilityHash } from '@agentbazaar/idl';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { ValidationError } from './errors.js';
import {
  getAssociatedTokenAddress,
  getEscrowProgramId,
  getUsdcMint,
  makeEscrowProgram,
} from './escrow-utils.js';
import { clusterFromConnection, PROGRAM_IDS } from './program-ids.js';
import type { SlaParams } from './types.js';

// ─── shared helpers ───────────────────────────────────────────────────────────

const U64_MAX = 18_446_744_073_709_551_615n;

const PRICING_MODEL_BYTE: Record<string, number> = {
  per_request: 0,
  per_job: 1,
  hourly: 2,
  subscription: 3,
};

function toAnchorSla(sla: SlaParams): {
  maxLatencyMs: number | null;
  minUptimePct: number | null;
  responseFormat: string | null;
  jsonSchemaUri: string | null;
  customParams: Array<{ key: string; value: string }>;
} {
  return {
    maxLatencyMs: sla.maxLatencyMs ?? null,
    minUptimePct: sla.minUptimePct ?? null,
    responseFormat: sla.responseFormat ?? null,
    jsonSchemaUri: sla.jsonSchemaUri ?? null,
    customParams: sla.customParams ?? [],
  };
}

/**
 * Wrap a single instruction in an unsigned Transaction with a fresh blockhash.
 * feePayer is set to `signerPubkey`.
 */
async function wrapIx(
  connection: Connection,
  signerPubkey: PublicKey,
  ix: TransactionInstruction,
): Promise<Transaction> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: signerPubkey });
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  tx.add(ix);
  return tx;
}

// ─── register ────────────────────────────────────────────────────────────────

export interface BuildRegisterTxInput {
  signerPubkey: PublicKey;
  capability: string;
  priceUsdcBaseUnits: bigint;
  satiAgentId: bigint;
  pricingModel: string; // 'per_request' | 'per_job' | 'hourly' | 'subscription'
  slaParams: SlaParams;
  metadataUri: string;
}

export interface BuildRegisterTxResult {
  transaction: Transaction;
  listingPubkey: PublicKey;
}

/**
 * Build an unsigned register_service transaction.
 *
 * Unlike `registerService()` this does NOT upload metadata to Pinata — the
 * caller is expected to pass the already-pinned `metadataUri`.
 */
export async function buildRegisterTx(
  connection: Connection,
  input: BuildRegisterTxInput,
): Promise<BuildRegisterTxResult> {
  if (!input.capability || input.capability.trim().length === 0) {
    throw new ValidationError('capability must not be empty');
  }
  if (input.priceUsdcBaseUnits < 0n || input.priceUsdcBaseUnits > U64_MAX) {
    throw new ValidationError(`priceUsdcBaseUnits out of u64 range: ${input.priceUsdcBaseUnits}`);
  }
  if (input.satiAgentId < 0n || input.satiAgentId > U64_MAX) {
    throw new ValidationError(`satiAgentId out of u64 range: ${input.satiAgentId}`);
  }
  const pricingModelByte = PRICING_MODEL_BYTE[input.pricingModel];
  if (pricingModelByte === undefined) {
    throw new ValidationError(
      `invalid pricingModel: ${input.pricingModel}; expected per_request|per_job|hourly|subscription`,
    );
  }
  if (!input.metadataUri || input.metadataUri.trim().length === 0) {
    throw new ValidationError('metadataUri must not be empty');
  }

  const capHash = await computeCapabilityHash(input.capability);
  const capHashArray = Array.from(capHash) as number[];

  const registryProgramId = PROGRAM_IDS[clusterFromConnection(connection)].registry;
  const [listingPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('listing'), input.signerPubkey.toBuffer(), Buffer.from(capHash)],
    registryProgramId,
  );

  // Build a read-only provider (no signing needed to build the instruction)
  const readonlyWallet = {
    publicKey: input.signerPubkey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  // biome-ignore lint/suspicious/noExplicitAny: read-only wallet stub for ix building
  const provider = new AnchorProvider(connection, readonlyWallet as any, {
    commitment: 'confirmed',
  });
  const program = new Program<BazaarRegistry>(BazaarRegistryIDL, provider);

  const ix = await program.methods
    .registerService(
      capHashArray,
      new BN(input.satiAgentId.toString()),
      new BN(input.priceUsdcBaseUnits.toString()),
      pricingModelByte,
      toAnchorSla(input.slaParams),
      input.metadataUri,
    )
    .accounts({ owner: input.signerPubkey })
    .instruction();

  const transaction = await wrapIx(connection, input.signerPubkey, ix);
  return { transaction, listingPubkey: listingPda };
}

// ─── hire ─────────────────────────────────────────────────────────────────────

export interface BuildHireTxInput {
  buyerPubkey: PublicKey;
  listingPubkey: PublicKey;
  budgetUsdcBaseUnits: bigint;
  timeoutSeconds: number;
  slaParams: SlaParams;
  nonce: bigint;
  usdcMint?: PublicKey;
}

export interface BuildHireTxResult {
  transaction: Transaction;
  escrowPubkey: PublicKey;
  vaultPubkey: PublicKey;
}

/**
 * Build an unsigned create_escrow transaction.
 *
 * Returns the expected escrow and vault PDAs alongside the serialisable tx.
 */
export async function buildHireTx(
  connection: Connection,
  input: BuildHireTxInput,
): Promise<BuildHireTxResult> {
  if (input.budgetUsdcBaseUnits <= 0n) {
    throw new ValidationError('budgetUsdcBaseUnits must be positive');
  }
  if (input.timeoutSeconds <= 0) {
    throw new ValidationError('timeoutSeconds must be positive');
  }

  const resolvedUsdcMint = input.usdcMint ?? getUsdcMint(connection);
  const nonceBuf = new BN(input.nonce.toString()).toArrayLike(Buffer, 'le', 8);
  const escrowProgramId = getEscrowProgramId(connection);

  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), input.buyerPubkey.toBuffer(), input.listingPubkey.toBuffer(), nonceBuf],
    escrowProgramId,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), escrowPda.toBuffer()],
    escrowProgramId,
  );

  const readonlyWallet = {
    publicKey: input.buyerPubkey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  // biome-ignore lint/suspicious/noExplicitAny: read-only wallet stub for ix building
  const program = makeEscrowProgram(connection, readonlyWallet as any);

  const buyerTokenAccount = getAssociatedTokenAddress(resolvedUsdcMint, input.buyerPubkey);

  const ix = await program.methods
    .createEscrow(
      new BN(input.budgetUsdcBaseUnits.toString()),
      input.slaParams.maxLatencyMs ?? null,
      input.slaParams.responseFormat ?? null,
      new BN(input.timeoutSeconds),
      new BN(input.nonce.toString()),
    )
    .accounts({
      buyer: input.buyerPubkey,
      listing: input.listingPubkey,
      buyerTokenAccount,
    })
    .instruction();

  const transaction = await wrapIx(connection, input.buyerPubkey, ix);
  return { transaction, escrowPubkey: escrowPda, vaultPubkey: vaultPda };
}

// ─── deliver ──────────────────────────────────────────────────────────────────

export interface BuildDeliverTxInput {
  signerPubkey: PublicKey; // provider/seller
  escrowPubkey: PublicKey;
  resultUri: string;
  resultHashHex: string; // 64 hex chars → 32 bytes
  usdcMint?: PublicKey;
}

/**
 * Build an unsigned submit_delivery transaction.
 */
export async function buildDeliverTx(
  connection: Connection,
  input: BuildDeliverTxInput,
): Promise<Transaction> {
  if (!input.resultUri || input.resultUri.trim().length === 0) {
    throw new ValidationError('resultUri must not be empty');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(input.resultHashHex)) {
    throw new ValidationError('resultHashHex must be exactly 64 hex characters (32 bytes)');
  }

  const resolvedUsdcMint = input.usdcMint ?? getUsdcMint(connection);
  const resultHash = Array.from(Buffer.from(input.resultHashHex, 'hex')) as number[];

  const readonlyWallet = {
    publicKey: input.signerPubkey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  // biome-ignore lint/suspicious/noExplicitAny: read-only wallet stub for ix building
  const program = makeEscrowProgram(connection, readonlyWallet as any);

  const sellerTokenAccount = getAssociatedTokenAddress(resolvedUsdcMint, input.signerPubkey);

  // biome-ignore lint/suspicious/noExplicitAny: escrow PDA has self-referential seeds; Anchor TS cannot statically resolve it — must be passed explicitly
  const accts = { escrow: input.escrowPubkey, sellerTokenAccount } as any;
  const ix = await program.methods
    .submitDelivery(input.resultUri, resultHash)
    .accounts(accts)
    .instruction();

  return wrapIx(connection, input.signerPubkey, ix);
}

// ─── confirm ──────────────────────────────────────────────────────────────────

export interface BuildConfirmTxInput {
  signerPubkey: PublicKey; // buyer
  escrowPubkey: PublicKey;
  slaSeverity: number; // 0=ok, 1=minor, 2=moderate, 3=major → maps to score 100/75/50/25
  listingPubkey?: PublicKey; // fetched from chain if not provided
  sellerPubkey?: PublicKey; // fetched from chain if not provided
  usdcMint?: PublicKey;
}

/**
 * Build an unsigned confirm_delivery transaction.
 *
 * `slaSeverity` is converted to a reputation score: 0→100, 1→75, 2→50, 3→25.
 * Pass `listingPubkey` and `sellerPubkey` to avoid a chain fetch.
 */
export async function buildConfirmTx(
  connection: Connection,
  input: BuildConfirmTxInput,
): Promise<Transaction> {
  if (input.slaSeverity < 0 || input.slaSeverity > 3 || !Number.isInteger(input.slaSeverity)) {
    throw new ValidationError('slaSeverity must be an integer 0–3');
  }

  const resolvedUsdcMint = input.usdcMint ?? getUsdcMint(connection);
  const score = 100 - input.slaSeverity * 25; // 0→100, 1→75, 2→50, 3→25

  const readonlyWallet = {
    publicKey: input.signerPubkey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  // biome-ignore lint/suspicious/noExplicitAny: read-only wallet stub for ix building
  const program = makeEscrowProgram(connection, readonlyWallet as any);

  // If caller didn't supply listing/seller, fetch from chain
  let listing = input.listingPubkey;
  let seller = input.sellerPubkey;

  if (!listing || !seller) {
    const escrow = await program.account.escrowAccount.fetchNullable(input.escrowPubkey);
    if (!escrow) {
      throw new ValidationError(`Escrow not found: ${input.escrowPubkey.toBase58()}`);
    }
    listing = listing ?? (escrow.listing as PublicKey);
    seller = seller ?? (escrow.seller as PublicKey);
  }

  const sellerTokenAccount = getAssociatedTokenAddress(resolvedUsdcMint, seller);
  const buyerTokenAccount = getAssociatedTokenAddress(resolvedUsdcMint, input.signerPubkey);

  // biome-ignore lint/suspicious/noExplicitAny: escrow PDA has self-referential seeds; Anchor TS cannot statically resolve it — must be passed explicitly
  const accts = {
    escrow: input.escrowPubkey,
    sellerTokenAccount,
    buyerTokenAccount,
    listing,
  } as any;
  const ix = await program.methods.confirmDelivery(score, []).accounts(accts).instruction();

  return wrapIx(connection, input.signerPubkey, ix);
}
