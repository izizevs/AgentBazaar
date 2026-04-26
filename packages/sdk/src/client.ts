import {
  Connection,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from '@solana/web3.js';
import { claimEscrowTimeout } from './claimTimeout.js';
import { confirmDelivery } from './confirm.js';
import { deliverJob } from './deliver.js';
import { discoverServices } from './discover.js';
import { openEscrowDispute } from './dispute.js';
import { NotImplementedError } from './errors.js';
import { DEVNET_USDC_MINT } from './escrow-utils.js';
import { hireAgent } from './hire.js';
import { registerService } from './register.js';
import type {
  ConfirmInput,
  DeliverInput,
  DiscoverInput,
  DisputeInput,
  EscrowHandle,
  HireInput,
  RegisterInput,
  RegisterResult,
  ServiceProvider,
} from './types.js';

/**
 * Minimal wallet interface required by the AgentBazaar SDK.
 * Compatible with Anchor's NodeWallet, wallet-adapter wallets, and any custom signer.
 */
export interface AnchorWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

export interface AgentBazaarConfig {
  /** Any Anchor-compatible wallet / signer. */
  wallet: AnchorWallet;
  /** Solana RPC endpoint URL or an existing Connection instance. */
  rpc: string | Connection;
  /** Pinata JWT for IPFS metadata uploads (required for register()). */
  pinataJwt?: string;
  /**
   * Discovery API base URL.
   * Defaults to the `DISCOVERY_API_URL` env var, then `http://localhost:8787` (local dev).
   * Production: `https://agentbazaar-api.r-443.workers.dev`
   *
   * As of SDK 0.2.2, `discover()` calls this API as the primary source and falls back
   * to `getProgramAccounts` only on network error / 5xx. Set this to the production URL
   * in any non-local environment.
   */
  discoveryApiUrl?: string;
  /** USDC mint address. Defaults to Circle devnet USDC (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU). */
  usdcMint?: string;
}

export class AgentBazaar {
  readonly connection: Connection;
  readonly wallet: AnchorWallet;
  readonly discoveryApiUrl: string;
  readonly usdcMint: PublicKey;
  // Private: prevents accidental exposure via JSON.stringify(client) or error-capture tooling.
  readonly #pinataJwt: string | undefined;

  constructor({ wallet, rpc, pinataJwt, discoveryApiUrl, usdcMint }: AgentBazaarConfig) {
    this.wallet = wallet;
    this.connection = typeof rpc === 'string' ? new Connection(rpc, 'confirmed') : rpc;
    this.#pinataJwt = pinataJwt;
    // L3: guard process.env access for browser environments without a process polyfill
    const envUrl = typeof process !== 'undefined' ? process.env?.DISCOVERY_API_URL : undefined;
    this.discoveryApiUrl = discoveryApiUrl ?? envUrl ?? 'http://localhost:8787';
    this.usdcMint = usdcMint ? new PublicKey(usdcMint) : DEVNET_USDC_MINT;
  }

  /**
   * Register this agent as a service provider on-chain.
   *
   * Validates input via MetadataSchema, uploads metadata to Pinata/IPFS,
   * derives the capability_hash, checks for a duplicate active listing,
   * and calls bazaar-registry::register_service with 3-attempt retry and
   * priority fee escalation.
   *
   * @throws {ValidationError} if input fails MetadataSchema validation
   * @throws {MetadataUploadError} if the Pinata upload fails
   * @throws {DuplicateListingError} if an active listing already exists for this capability
   * @throws {TransactionFailedError} if the transaction fails after all retry attempts
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    if (!this.#pinataJwt) throw new NotImplementedError('register (pinataJwt not configured)');
    return registerService(this.connection, this.wallet, input, this.#pinataJwt);
  }

  /**
   * Discover available service providers.
   * Falls back to direct RPC if the Discovery API indexer is unreachable.
   */
  async discover(input: DiscoverInput): Promise<ServiceProvider[]> {
    return discoverServices(this.connection, this.wallet, input, this.discoveryApiUrl);
  }

  /**
   * Hire an agent by creating a USDC escrow on-chain.
   *
   * Validates input, derives escrow + vault PDAs, checks buyer USDC balance,
   * and calls bazaar-escrow::create_escrow with 3-attempt retry + priority fee escalation.
   * Idempotent: if the same buyer+listing+nonce escrow already exists, returns the existing handle.
   *
   * **Production retry safety**: if `hire()` throws after an ambiguous network failure
   * (tx may have landed but confirmation timed out), calling `hire()` again with a new
   * `Date.now()`-derived nonce creates a second escrow and a second USDC deposit.
   * Pass an explicit `input.nonce` derived from stable inputs (buyer + listing + budget)
   * so that retries resolve to the same PDA and the idempotency path is taken instead.
   *
   * @throws {ValidationError} if input is invalid
   * @throws {InvalidListingError} if agentId is not a valid public key
   * @throws {InsufficientFundsError} if buyer has insufficient USDC
   * @throws {EscrowAlreadyExistsError} if escrow exists in a non-created state
   * @throws {TransactionFailedError} if the transaction fails after all retry attempts
   */
  async hire(agentId: string, input: HireInput): Promise<EscrowHandle> {
    return hireAgent(this.connection, this.wallet, agentId, input, this.usdcMint);
  }

  /**
   * Submit job result as the hired agent (seller side).
   *
   * @throws {EscrowNotFoundError} if escrow does not exist
   * @throws {EscrowAlreadyDeliveredError} if delivery already submitted
   * @throws {EscrowAlreadyResolvedError} if escrow is in a terminal state
   * @throws {ValidationError} if resultUri is empty or resultHash is not 32 bytes
   * @throws {TransactionFailedError} if the transaction fails
   */
  async deliver(escrowId: string, input: DeliverInput): Promise<string> {
    return deliverJob(this.connection, this.wallet, escrowId, input, this.usdcMint);
  }

  /**
   * Confirm job completion as the buyer, releasing USDC to the seller.
   *
   * @throws {EscrowNotFoundError} if escrow does not exist
   * @throws {DeliveryNotSubmittedError} if no delivery has been submitted yet
   * @throws {EscrowAlreadyConfirmedError} if already confirmed
   * @throws {ValidationError} if score is outside 0–100
   * @throws {TransactionFailedError} if the transaction fails
   */
  async confirm(escrowId: string, input: ConfirmInput): Promise<string> {
    return confirmDelivery(this.connection, this.wallet, escrowId, input, this.usdcMint);
  }

  /**
   * Claim escrow funds as the seller after the SLA timeout has elapsed.
   *
   * @throws {EscrowNotFoundError} if escrow does not exist
   * @throws {DeliveryNotSubmittedError} if no delivery was submitted
   * @throws {EscrowNotExpiredError} if the deadline has not yet passed (on-chain)
   * @throws {EscrowAlreadyResolvedError} if escrow is in a terminal state
   * @throws {TransactionFailedError} if the transaction fails
   */
  async claimTimeout(escrowId: string): Promise<string> {
    return claimEscrowTimeout(this.connection, this.wallet, escrowId, this.usdcMint);
  }

  /**
   * Open a dispute against an active escrow, triggering an immediate refund (M1 stub).
   *
   * @throws {EscrowNotFoundError} if escrow does not exist
   * @throws {EscrowAlreadyDisputedError} if dispute already opened
   * @throws {EscrowAlreadyResolvedError} if escrow is in a terminal state
   * @throws {ValidationError} if reason is empty
   * @throws {TransactionFailedError} if the transaction fails
   */
  async dispute(escrowId: string, input: DisputeInput): Promise<string> {
    return openEscrowDispute(this.connection, this.wallet, escrowId, input, this.usdcMint);
  }

  /**
   * Request an on-chain SLA evaluation from the bazaar-evaluator program.
   */
  async requestEvaluation(_escrowId: string): Promise<string> {
    throw new NotImplementedError('requestEvaluation');
  }

  toJSON() {
    return { wallet: { publicKey: this.wallet.publicKey.toBase58() } };
  }
}
