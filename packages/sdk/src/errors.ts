/** Base class for all AgentBazaar SDK errors. */
export class AgentBazaarError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a method stub has not been implemented yet. */
export class NotImplementedError extends AgentBazaarError {
  constructor(method: string) {
    super(`AgentBazaar.${method}() is not yet implemented`);
  }
}

/** Thrown when client-side input validation fails before sending a transaction. */
export class ValidationError extends AgentBazaarError {}

/** Thrown when a transaction fails on-chain. */
export class TransactionFailedError extends AgentBazaarError {
  constructor(
    message: string,
    public readonly signature?: string,
  ) {
    super(message);
  }
}

/** Thrown when the caller has insufficient USDC balance for the operation. */
export class InsufficientFundsError extends AgentBazaarError {}

/** Thrown when the metadata_uri upload to Pinata/Arweave fails. */
export class MetadataUploadError extends AgentBazaarError {}

/** Thrown when a register() call finds an already-active listing for the same capability. */
export class DuplicateListingError extends AgentBazaarError {}
