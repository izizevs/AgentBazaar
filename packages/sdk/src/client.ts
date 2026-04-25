import {
  Connection,
  type PublicKey,
  type Transaction,
  type VersionedTransaction,
} from '@solana/web3.js';
import { NotImplementedError } from './errors.js';
import { registerService } from './register.js';
import type {
  ConfirmInput,
  DeliverInput,
  DiscoverInput,
  DisputeInput,
  HireInput,
  Job,
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
}

export class AgentBazaar {
  readonly connection: Connection;
  readonly wallet: AnchorWallet;
  // Private: prevents accidental exposure via JSON.stringify(client) or error-capture tooling.
  readonly #pinataJwt: string | undefined;

  constructor({ wallet, rpc, pinataJwt }: AgentBazaarConfig) {
    this.wallet = wallet;
    this.connection = typeof rpc === 'string' ? new Connection(rpc, 'confirmed') : rpc;
    this.#pinataJwt = pinataJwt;
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
  async discover(_input: DiscoverInput): Promise<ServiceProvider[]> {
    throw new NotImplementedError('discover');
  }

  /**
   * Hire an agent by creating an escrow and funding it with USDC.
   */
  async hire(_agentId: string, _input: HireInput): Promise<Job> {
    throw new NotImplementedError('hire');
  }

  /**
   * Submit job result as the hired agent.
   */
  async deliver(_escrowId: string, _input: DeliverInput): Promise<string> {
    throw new NotImplementedError('deliver');
  }

  /**
   * Confirm job completion as the client and release escrow to the agent.
   */
  async confirm(_escrowId: string, _input: ConfirmInput): Promise<string> {
    throw new NotImplementedError('confirm');
  }

  /**
   * Claim escrow funds back after SLA timeout has elapsed.
   */
  async claimTimeout(_escrowId: string): Promise<string> {
    throw new NotImplementedError('claimTimeout');
  }

  /**
   * Open a dispute against a completed or in-progress job.
   */
  async dispute(_escrowId: string, _input: DisputeInput): Promise<string> {
    throw new NotImplementedError('dispute');
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
