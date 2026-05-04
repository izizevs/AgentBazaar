/**
 * error-handling.ts — demonstrates catching and inspecting every error class
 * exported by @agent-bazaar/sdk.
 *
 * No network calls are made; errors are constructed locally to show the
 * instanceof pattern and structured fields available on each class.
 *
 * Run:
 *   npx tsx examples/error-handling.ts
 */

import {
  AgentBazaarError,
  DegradedDiscoveryError,
  DiscoveryAPIError,
  DuplicateListingError,
  IDLMismatchError,
  InsufficientFundsError,
  MetadataUploadError,
  NotImplementedError,
  RPCFallbackFailedError,
  TransactionFailedError,
  ValidationError,
  WalletNotConnectedError,
} from '@agent-bazaar/sdk';

// ── Helper ────────────────────────────────────────────────────────────────────

function handle(err: unknown) {
  // All SDK errors extend AgentBazaarError — a single top-level guard is sufficient
  // to distinguish SDK errors from unexpected runtime exceptions.
  if (!(err instanceof AgentBazaarError)) {
    console.error('[unexpected]', err);
    return;
  }

  // Then narrow to the specific subclass to access structured fields.
  if (err instanceof ValidationError) {
    console.log(`ValidationError: ${err.message}`);
  } else if (err instanceof TransactionFailedError) {
    console.log(`TransactionFailedError: ${err.message}`);
    if (err.signature) {
      console.log(`  Explorer: https://explorer.solana.com/tx/${err.signature}?cluster=devnet`);
    }
  } else if (err instanceof InsufficientFundsError) {
    console.log(`InsufficientFundsError: need ${err.required} µUSDC, have ${err.available} µUSDC`);
    const shortfall = err.required - err.available;
    console.log(`  Shortfall: ${shortfall} µUSDC (${Number(shortfall) / 1e6} USDC)`);
  } else if (err instanceof MetadataUploadError) {
    console.log(`MetadataUploadError: ${err.message}`);
  } else if (err instanceof DuplicateListingError) {
    console.log(`DuplicateListingError: ${err.message}`);
    console.log('  Call client.updateListing() to update the existing record instead.');
  } else if (err instanceof DegradedDiscoveryError) {
    console.log(`DegradedDiscoveryError: ${err.message}`);
    console.log('  Unavailable filters:', err.filtersDropped);
    console.log('  Retry without those filters, or wait for the Discovery API to recover.');
  } else if (err instanceof DiscoveryAPIError) {
    console.log(`DiscoveryAPIError: ${err.message}`);
    if (err.statusCode !== undefined) {
      console.log(`  HTTP status: ${err.statusCode}`);
      if (err.statusCode === 401) console.log('  Check your Discovery API credentials.');
      if (err.statusCode === 429) console.log('  Rate limited — back off and retry.');
    }
  } else if (err instanceof RPCFallbackFailedError) {
    console.log(`RPCFallbackFailedError: ${err.message}`);
    if (err.cause instanceof Error) {
      console.log('  Root cause:', err.cause.message);
    }
  } else if (err instanceof WalletNotConnectedError) {
    console.log(`WalletNotConnectedError: ${err.message}`);
    console.log('  Prompt the user to connect a wallet before calling SDK methods.');
  } else if (err instanceof IDLMismatchError) {
    console.log(`IDLMismatchError: ${err.message}`);
    if (err.expected && err.got) {
      console.log(`  Expected IDL version ${err.expected}, got ${err.got}.`);
      console.log('  Upgrade @agent-bazaar/sdk to match the deployed program version.');
    }
  } else if (err instanceof NotImplementedError) {
    console.log(`NotImplementedError: ${err.message}`);
    console.log('  This method ships in M1 (escrow flows).');
  } else {
    // Unknown AgentBazaarError subclass — log generically.
    console.log(`${err.name}: ${err.message}`);
  }
}

// ── Exercise each class ───────────────────────────────────────────────────────

console.log('=== AgentBazaar SDK error class examples ===\n');

const examples: unknown[] = [
  new ValidationError('priceUsdc must be a positive bigint'),
  new TransactionFailedError('Transaction simulation failed: blockhash expired', '3xY9...'),
  new InsufficientFundsError(5_000_000n, 1_234_567n),
  new MetadataUploadError('Pinata upload failed: 413 Payload Too Large'),
  new DuplicateListingError('Active listing already exists: AbCd...'),
  new DegradedDiscoveryError(['minReputation', 'sort']),
  new DiscoveryAPIError('Discovery API error: 429 Too Many Requests', 429),
  new RPCFallbackFailedError('RPC fallback failed: failed to get account info', {
    cause: new Error('getAccountInfo: Connection timed out'),
  }),
  new WalletNotConnectedError(),
  new IDLMismatchError('0.1.0', '0.0.9'),
  new NotImplementedError('hire'),
];

for (const err of examples) {
  handle(err);
  console.log();
}

// ── Cause chain example ───────────────────────────────────────────────────────

console.log('=== Cause chain traversal ===\n');

const root = new TypeError('fetch failed');
const wrapped = new RPCFallbackFailedError('RPC fallback failed: fetch failed', { cause: root });

console.log('err.message   :', wrapped.message);
console.log('err.cause     :', (wrapped.cause as Error).message);
console.log('instanceof check:', wrapped instanceof AgentBazaarError); // true
