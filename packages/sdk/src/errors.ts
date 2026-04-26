/**
 * Base class for all AgentBazaar SDK errors.
 * Catch any SDK error with a single `instanceof AgentBazaarError` check.
 */
export class AgentBazaarError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when a method stub has not been implemented yet. */
export class NotImplementedError extends AgentBazaarError {
  constructor(method: string) {
    super(`AgentBazaar.${method}() is not yet implemented`);
  }
}

/** Thrown when client-side input validation fails (Zod schema or range guard). */
export class ValidationError extends AgentBazaarError {}

/**
 * Thrown when a transaction fails on-chain after all retry attempts.
 * `signature` is set when the tx was confirmed but the program returned an error code;
 * it is undefined when the tx never landed (e.g., blockhash expired).
 */
export class TransactionFailedError extends AgentBazaarError {
  readonly signature?: string;
  constructor(message: string, signature?: string, options?: ErrorOptions) {
    super(message, options);
    this.signature = signature;
  }
}

/**
 * Thrown when the caller has insufficient USDC balance for the operation.
 * Both amounts are in USDC micro-units (6 decimals).
 */
export class InsufficientFundsError extends AgentBazaarError {
  readonly required: bigint;
  readonly available: bigint;
  constructor(required: bigint, available: bigint, options?: ErrorOptions) {
    super(`Insufficient funds: required ${required} µUSDC, available ${available} µUSDC`, options);
    this.required = required;
    this.available = available;
  }
}

/** Thrown when the metadata_uri upload to Pinata/Arweave fails. */
export class MetadataUploadError extends AgentBazaarError {}

/** Thrown when register() finds an already-active listing for the same capability. */
export class DuplicateListingError extends AgentBazaarError {}

/**
 * Thrown when the Discovery API is unreachable, returns a non-2xx status,
 * or returns a response body that fails schema validation.
 * `statusCode` is populated when the server responded with an HTTP error;
 * it is undefined on network errors, timeouts, or JSON/schema parse failures.
 */
export class DiscoveryAPIError extends AgentBazaarError {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.statusCode = statusCode;
  }
}

/** Thrown when the Discovery API fails and the RPC fallback also fails. */
export class RPCFallbackFailedError extends AgentBazaarError {}

/**
 * Thrown when discover() degrades to the RPC fallback and one or more requested
 * filters cannot be applied (e.g., `minReputation` — reputation is not stored on-chain in M0).
 * `filtersDropped` lists the filter parameter names that were unavailable.
 * `rpcResults` contains the best-effort RPC fallback results; callers may choose to use
 * them despite the degraded state (e.g., show results with a "live data unavailable" banner).
 * UI should render "reputation filtering unavailable — results may include low-reputation agents".
 */
export class DegradedDiscoveryError<TListing = unknown> extends AgentBazaarError {
  readonly filtersDropped: readonly string[];
  /**
   * Best-effort RPC fallback results. Present when the fallback succeeded but the
   * Discovery API was unavailable. May be empty when `filtersDropped` includes filters
   * that cannot be honoured via RPC (e.g., `minReputation`).
   */
  readonly rpcResults: readonly TListing[];
  constructor(filtersDropped: string[], options?: ErrorOptions & { rpcResults?: TListing[] }) {
    const msg =
      filtersDropped.length > 0
        ? `Discovery degraded to RPC fallback; filters unavailable: ${filtersDropped.join(', ')}`
        : 'Discovery degraded to RPC fallback; Discovery API unavailable';
    super(msg, options);
    this.filtersDropped = Object.freeze(filtersDropped);
    this.rpcResults = Object.freeze(options?.rpcResults ?? []);
  }
}

/**
 * Thrown when an operation requires a connected wallet but `publicKey` is not available.
 * Typically indicates the wallet adapter has not been connected yet.
 */
export class WalletNotConnectedError extends AgentBazaarError {
  constructor(options?: ErrorOptions) {
    super('No wallet connected', options);
  }
}

/**
 * Thrown when the runtime IDL version does not match the expected on-chain program version.
 * `expected` is the version string embedded in the IDL package;
 * `got` is the discriminator or version found on-chain.
 */
export class IDLMismatchError extends AgentBazaarError {
  readonly expected?: string;
  readonly got?: string;
  constructor(expected?: string, got?: string, options?: ErrorOptions) {
    super(
      expected && got
        ? `IDL version mismatch: expected ${expected}, got ${got}`
        : 'IDL version mismatch',
      options,
    );
    this.expected = expected;
    this.got = got;
  }
}

// ─── Escrow errors ───────────────────────────────────────────────────────────

/** Thrown when the escrow PDA does not exist on-chain. */
export class EscrowNotFoundError extends AgentBazaarError {
  constructor(escrowId: string, options?: ErrorOptions) {
    super(`Escrow not found: ${escrowId}`, options);
  }
}

/** Thrown when hire() is called but the escrow PDA already exists with a different state. */
export class EscrowAlreadyExistsError extends AgentBazaarError {
  constructor(escrowId: string, options?: ErrorOptions) {
    super(`Escrow already exists: ${escrowId}`, options);
  }
}

/** Thrown when deliver() is called but delivery was already submitted. */
export class EscrowAlreadyDeliveredError extends AgentBazaarError {
  constructor(escrowId: string, options?: ErrorOptions) {
    super(`Delivery already submitted for escrow: ${escrowId}`, options);
  }
}

/** Thrown when confirm() is called but the escrow was already confirmed. */
export class EscrowAlreadyConfirmedError extends AgentBazaarError {
  constructor(escrowId: string, options?: ErrorOptions) {
    super(`Escrow already confirmed: ${escrowId}`, options);
  }
}

/** Thrown when the escrow deadline has passed (e.g., deliver() called too late). */
export class EscrowExpiredError extends AgentBazaarError {
  constructor(escrowId: string, options?: ErrorOptions) {
    super(`Escrow deadline has passed: ${escrowId}`, options);
  }
}

/** Thrown when claimTimeout() is called but the deadline has not yet passed. */
export class EscrowNotExpiredError extends AgentBazaarError {
  constructor(escrowId: string, options?: ErrorOptions) {
    super(`Escrow deadline has not yet passed: ${escrowId}`, options);
  }
}

/** Thrown when dispute() is called but the escrow is already in a disputed state. */
export class EscrowAlreadyDisputedError extends AgentBazaarError {
  constructor(escrowId: string, options?: ErrorOptions) {
    super(`Escrow already disputed: ${escrowId}`, options);
  }
}

/** Thrown when an action requires the escrow to be resolved but it is not. */
export class EscrowAlreadyResolvedError extends AgentBazaarError {
  constructor(escrowId: string, options?: ErrorOptions) {
    super(`Escrow already resolved (confirmed or timeout-claimed): ${escrowId}`, options);
  }
}

/** Thrown when confirm() or claimTimeout() is called but no delivery has been submitted yet. */
export class DeliveryNotSubmittedError extends AgentBazaarError {
  constructor(escrowId: string, options?: ErrorOptions) {
    super(`No delivery submitted for escrow: ${escrowId}`, options);
  }
}

/** Thrown when the caller is not the authorized party (buyer or seller) for the escrow. */
export class UnauthorizedError extends AgentBazaarError {
  constructor(message?: string, options?: ErrorOptions) {
    super(message ?? 'Unauthorized: caller is not the authorized party', options);
  }
}

/** Thrown when hire() references a listing that does not exist or is inactive. */
export class InvalidListingError extends AgentBazaarError {
  constructor(listingId: string, options?: ErrorOptions) {
    super(`Invalid or inactive listing: ${listingId}`, options);
  }
}

/**
 * Thrown when `clusterFromConnection()` cannot map an RPC endpoint URL to a
 * known Solana cluster. Callers should verify the endpoint matches one of:
 * `*.devnet.solana.com`, `*devnet*`, `localhost`, `127.0.0.1`,
 * `*testnet*`, `*mainnet*`.
 */
export class UnknownClusterError extends AgentBazaarError {
  readonly endpoint: string;
  constructor(endpoint: string, options?: ErrorOptions) {
    super(`Cannot determine Solana cluster from RPC endpoint: ${endpoint}`, options);
    this.endpoint = endpoint;
  }
}
