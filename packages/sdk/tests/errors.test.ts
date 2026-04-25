import { describe, expect, it } from 'vitest';
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
} from '../src/errors.js';

// ─── inheritance ──────────────────────────────────────────────────────────────

describe('inheritance chain', () => {
  const allClasses = [
    NotImplementedError,
    ValidationError,
    TransactionFailedError,
    InsufficientFundsError,
    MetadataUploadError,
    DuplicateListingError,
    DiscoveryAPIError,
    RPCFallbackFailedError,
    DegradedDiscoveryError,
    WalletNotConnectedError,
    IDLMismatchError,
  ] as const;

  it.each(allClasses.map((C) => [C.name, C]))('%s extends AgentBazaarError', (_name, Cls) => {
    // biome-ignore lint/suspicious/noExplicitAny: constructing with dummy args for type test
    const instance = constructDummy(Cls as any);
    expect(instance).toBeInstanceOf(AgentBazaarError);
    expect(instance).toBeInstanceOf(Error);
  });

  it.each(allClasses.map((C) => [C.name, C]))('%s has correct name property', (_name, Cls) => {
    // biome-ignore lint/suspicious/noExplicitAny: constructing with dummy args for type test
    const instance = constructDummy(Cls as any);
    expect(instance.name).toBe(Cls.name);
  });
});

// Construct each error class with minimal valid arguments for generic tests.
// biome-ignore lint/suspicious/noExplicitAny: intentional
function constructDummy(Cls: any): AgentBazaarError {
  switch (Cls) {
    case NotImplementedError:
      return new NotImplementedError('test');
    case InsufficientFundsError:
      return new InsufficientFundsError(100n, 50n);
    case TransactionFailedError:
      return new TransactionFailedError('failed');
    case DegradedDiscoveryError:
      return new DegradedDiscoveryError(['minReputation']);
    case WalletNotConnectedError:
      return new WalletNotConnectedError();
    case IDLMismatchError:
      return new IDLMismatchError();
    default:
      return new Cls('test message');
  }
}

// ─── NotImplementedError ──────────────────────────────────────────────────────

describe('NotImplementedError', () => {
  it('formats message with method name', () => {
    const err = new NotImplementedError('hire');
    expect(err.message).toBe('AgentBazaar.hire() is not yet implemented');
  });
});

// ─── TransactionFailedError ───────────────────────────────────────────────────

describe('TransactionFailedError', () => {
  it('stores signature when provided', () => {
    const sig = '5wHu1234567890abc';
    const err = new TransactionFailedError('on-chain error', sig);
    expect(err.signature).toBe(sig);
    expect(err.message).toBe('on-chain error');
  });

  it('signature is undefined when omitted', () => {
    const err = new TransactionFailedError('timeout');
    expect(err.signature).toBeUndefined();
  });

  it('propagates cause', () => {
    const cause = new Error('rpc timeout');
    const err = new TransactionFailedError('failed', undefined, { cause });
    expect(err.cause).toBe(cause);
  });
});

// ─── InsufficientFundsError ───────────────────────────────────────────────────

describe('InsufficientFundsError', () => {
  it('stores required and available amounts', () => {
    const err = new InsufficientFundsError(5_000_000n, 1_000_000n);
    expect(err.required).toBe(5_000_000n);
    expect(err.available).toBe(1_000_000n);
  });

  it('message includes both amounts', () => {
    const err = new InsufficientFundsError(5_000_000n, 1_000_000n);
    expect(err.message).toContain('5000000');
    expect(err.message).toContain('1000000');
  });

  it('propagates cause', () => {
    const cause = new Error('balance fetch failed');
    const err = new InsufficientFundsError(100n, 0n, { cause });
    expect(err.cause).toBe(cause);
  });
});

// ─── DiscoveryAPIError ────────────────────────────────────────────────────────

describe('DiscoveryAPIError', () => {
  it('stores HTTP status code when provided', () => {
    const err = new DiscoveryAPIError('not found', 404);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('not found');
  });

  it('statusCode is undefined for network/parse errors', () => {
    const err = new DiscoveryAPIError('connection refused');
    expect(err.statusCode).toBeUndefined();
  });

  it('propagates cause', () => {
    const cause = new TypeError('failed to fetch');
    const err = new DiscoveryAPIError('unreachable', undefined, { cause });
    expect(err.cause).toBe(cause);
  });
});

// ─── RPCFallbackFailedError ───────────────────────────────────────────────────

describe('RPCFallbackFailedError', () => {
  it('propagates cause', () => {
    const cause = new Error('connection dropped');
    const err = new RPCFallbackFailedError('RPC fallback failed', { cause });
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('RPC fallback failed');
  });
});

// ─── DegradedDiscoveryError ───────────────────────────────────────────────────

describe('DegradedDiscoveryError', () => {
  it('stores dropped filter names', () => {
    const err = new DegradedDiscoveryError(['minReputation']);
    expect(err.filtersDropped).toEqual(['minReputation']);
  });

  it('message lists dropped filters', () => {
    const err = new DegradedDiscoveryError(['minReputation', 'sort']);
    expect(err.message).toContain('minReputation');
    expect(err.message).toContain('sort');
  });

  it('filtersDropped is frozen at runtime', () => {
    const err = new DegradedDiscoveryError(['minReputation']);
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: testing runtime freeze
      (err.filtersDropped as any).push('extra');
    }).toThrow();
  });
});

// ─── WalletNotConnectedError ──────────────────────────────────────────────────

describe('WalletNotConnectedError', () => {
  it('has a fixed message', () => {
    const err = new WalletNotConnectedError();
    expect(err.message).toBe('No wallet connected');
  });

  it('propagates cause', () => {
    const cause = new Error('adapter not found');
    const err = new WalletNotConnectedError({ cause });
    expect(err.cause).toBe(cause);
  });
});

// ─── IDLMismatchError ─────────────────────────────────────────────────────────

describe('IDLMismatchError', () => {
  it('formats message with expected and got', () => {
    const err = new IDLMismatchError('0.1.0', '0.2.0');
    expect(err.expected).toBe('0.1.0');
    expect(err.got).toBe('0.2.0');
    expect(err.message).toContain('0.1.0');
    expect(err.message).toContain('0.2.0');
  });

  it('generic message when versions are omitted', () => {
    const err = new IDLMismatchError();
    expect(err.message).toBe('IDL version mismatch');
    expect(err.expected).toBeUndefined();
    expect(err.got).toBeUndefined();
  });

  it('propagates cause', () => {
    const cause = new Error('account fetch failed');
    const err = new IDLMismatchError('0.1.0', '0.2.0', { cause });
    expect(err.cause).toBe(cause);
  });
});

// ─── simple subclasses ────────────────────────────────────────────────────────

describe('simple error subclasses', () => {
  it('MetadataUploadError preserves message and cause', () => {
    const cause = new Error('pinata 500');
    const err = new MetadataUploadError('upload failed', { cause });
    expect(err.message).toBe('upload failed');
    expect(err.cause).toBe(cause);
  });

  it('DuplicateListingError preserves message', () => {
    const err = new DuplicateListingError('listing already active');
    expect(err.message).toBe('listing already active');
  });

  it('ValidationError preserves message', () => {
    const err = new ValidationError('name must be ≤64 chars');
    expect(err.message).toBe('name must be ≤64 chars');
  });
});
