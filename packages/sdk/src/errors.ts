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
export class ValidationError extends AgentBazaarError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

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
export class MetadataUploadError extends AgentBazaarError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Thrown when register() finds an already-active listing for the same capability. */
export class DuplicateListingError extends AgentBazaarError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

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
export class RPCFallbackFailedError extends AgentBazaarError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Thrown when discover() degrades to the RPC fallback and one or more requested
 * filters cannot be applied (e.g., `minReputation` — reputation is not stored on-chain in M0).
 * `filtersDropped` lists the filter parameter names that were unavailable.
 * UI should render "reputation filtering unavailable — results may include low-reputation agents".
 */
export class DegradedDiscoveryError extends AgentBazaarError {
  readonly filtersDropped: readonly string[];
  constructor(filtersDropped: string[], options?: ErrorOptions) {
    super(
      `Discovery degraded to RPC fallback; filters unavailable: ${filtersDropped.join(', ')}`,
      options,
    );
    this.filtersDropped = Object.freeze(filtersDropped);
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
