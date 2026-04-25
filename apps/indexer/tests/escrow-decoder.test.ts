import { describe, expect, it } from 'vitest';
import {
  decodeEscrowEvent,
  decodeEscrowState,
  decodeSlaSeverity,
} from '../src/events/escrow-decoder.js';

describe('decodeEscrowState', () => {
  it('maps created', () => expect(decodeEscrowState({ created: {} })).toBe('created'));
  it('maps delivered', () => expect(decodeEscrowState({ delivered: {} })).toBe('delivered'));
  it('maps confirmed', () => expect(decodeEscrowState({ confirmed: {} })).toBe('confirmed'));
  it('maps disputed', () => expect(decodeEscrowState({ disputed: {} })).toBe('disputed'));
  it('maps timeoutClaimed → timeout_claimed', () =>
    expect(decodeEscrowState({ timeoutClaimed: {} })).toBe('timeout_claimed'));
  it('throws on empty object', () => expect(() => decodeEscrowState({})).toThrow());
});

describe('decodeSlaSeverity', () => {
  it('maps minor', () => expect(decodeSlaSeverity({ minor: {} })).toBe('minor'));
  it('maps moderate', () => expect(decodeSlaSeverity({ moderate: {} })).toBe('moderate'));
  it('maps major', () => expect(decodeSlaSeverity({ major: {} })).toBe('major'));
  it('throws on empty object', () => expect(() => decodeSlaSeverity({})).toThrow());
});

describe('decodeEscrowEvent', () => {
  it('returns null for garbage base64', () => {
    expect(decodeEscrowEvent('aGVsbG8=')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(decodeEscrowEvent('')).toBeNull();
  });

  it('returns null for registry event data (wrong discriminator)', () => {
    // 8 zero bytes base64-encoded — not a valid escrow event discriminator
    expect(decodeEscrowEvent('AAAAAAAAAAA=')).toBeNull();
  });
});
