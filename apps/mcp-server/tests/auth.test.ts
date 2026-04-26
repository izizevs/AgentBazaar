import { describe, expect, it } from 'vitest';
import { extractBearerToken, validateToken } from '../src/auth.js';

describe('extractBearerToken', () => {
  it('returns null for undefined', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(extractBearerToken(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractBearerToken('')).toBeNull();
  });

  it('returns null for missing Bearer prefix', () => {
    expect(extractBearerToken('token123')).toBeNull();
  });

  it('returns null for Basic auth', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('extracts token from valid header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('extracts hex token', () => {
    const token = 'a1b2c3d4e5f6' as const;
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
  });

  it('returns null when no token after Bearer', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('validateToken', () => {
  it('returns true for identical tokens', () => {
    expect(validateToken('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different tokens of same length', () => {
    expect(validateToken('abc123', 'xyz789')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(validateToken('short', 'longer-token')).toBe(false);
  });

  it('returns false for empty vs non-empty', () => {
    expect(validateToken('', 'token')).toBe(false);
  });

  it('returns true for empty vs empty', () => {
    expect(validateToken('', '')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(validateToken('Token', 'token')).toBe(false);
  });
});
