import { describe, expect, it } from 'vitest';
import { IDL } from '../generated/bazaar-registry.js';
import { computeCapabilityHash, MetadataSchema } from '../metadata-schema.js';

describe('bazaar-registry IDL', () => {
  it('matches snapshot — catches accidental IDL drift', () => {
    expect({
      address: IDL.address,
      name: IDL.metadata.name,
      version: IDL.metadata.version,
      instructionNames: IDL.instructions.map((ix) => ix.name),
      accountNames: IDL.accounts.map((a) => a.name),
      typeNames: IDL.types.map((t) => t.name),
      errorNames: IDL.errors.map((e) => e.name),
    }).toMatchSnapshot();
  });

  it('has expected program address', () => {
    expect(IDL.address).toBe('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd');
  });

  it('has 4 instructions', () => {
    expect(IDL.instructions).toHaveLength(4);
  });

  it('has ServiceListing account', () => {
    // JSON uses PascalCase names; TS type uses camelCase — check the runtime value.
    const names = IDL.accounts.map((a) => a.name as string);
    expect(names.some((n) => n === 'ServiceListing' || n === 'serviceListing')).toBe(true);
  });
});

describe('MetadataSchema', () => {
  it('accepts a valid metadata payload', () => {
    const result = MetadataSchema.safeParse({
      name: 'my-agent',
      description: 'Does stuff',
      capability: 'text-summarisation-v1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional avatar (https) and custom fields', () => {
    const result = MetadataSchema.safeParse({
      name: 'agent',
      description: 'x',
      capability: 'cap',
      avatar: 'https://example.com/avatar.png',
      custom: { tier: 'pro', region: 'us-east' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = MetadataSchema.safeParse({
      name: '',
      description: 'ok',
      capability: 'cap',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name longer than 64 chars', () => {
    const result = MetadataSchema.safeParse({
      name: 'a'.repeat(65),
      description: 'ok',
      capability: 'cap',
    });
    expect(result.success).toBe(false);
  });

  it('rejects description longer than 500 chars', () => {
    const result = MetadataSchema.safeParse({
      name: 'agent',
      description: 'x'.repeat(501),
      capability: 'cap',
    });
    expect(result.success).toBe(false);
  });

  it('rejects capability longer than 256 chars', () => {
    const result = MetadataSchema.safeParse({
      name: 'agent',
      description: 'ok',
      capability: 'x'.repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid avatar URL', () => {
    const result = MetadataSchema.safeParse({
      name: 'agent',
      description: 'ok',
      capability: 'cap',
      avatar: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-https avatar schemes (javascript:, data:, http:)', () => {
    for (const avatar of [
      'javascript:alert(1)',
      'data:text/html,<h1>xss</h1>',
      'http://example.com/img.png',
    ]) {
      const result = MetadataSchema.safeParse({
        name: 'agent',
        description: 'ok',
        capability: 'cap',
        avatar,
      });
      expect(result.success, `expected ${avatar} to be rejected`).toBe(false);
    }
  });

  it('prototype pollution regression — __proto__ in custom is stripped by Zod (CVE-2023-4316)', () => {
    // Zod 3.22.3+ fixed prototype pollution; this test locks the behaviour.
    const result = MetadataSchema.parse({
      name: 'agent',
      description: 'ok',
      capability: 'cap',
      // biome-ignore lint/suspicious/noExplicitAny: intentional pollution probe
      custom: { __proto__: { polluted: true } } as any,
    });
    // The object created by Zod must not have polluted Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // And the parsed result's custom must not carry __proto__ as an own key that patches prototype.
    expect(Object.hasOwn(result.custom ?? {}, '__proto__')).toBe(false);
  });
});

describe('computeCapabilityHash', () => {
  it('returns a 32-byte Uint8Array', async () => {
    const hash = await computeCapabilityHash('text-summarisation-v1');
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.byteLength).toBe(32);
  });

  it('is deterministic', async () => {
    const a = await computeCapabilityHash('cap-abc');
    const b = await computeCapabilityHash('cap-abc');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('differs for different inputs', async () => {
    const a = await computeCapabilityHash('cap-x');
    const b = await computeCapabilityHash('cap-y');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('matches known SHA-256 digest', async () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = await computeCapabilityHash('');
    const hex = Array.from(hash)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('codegen: program name safety (mirrors scripts/codegen.mjs assertSafeProgramName)', () => {
  // This regex must stay in sync with assertSafeProgramName in scripts/codegen.mjs.
  const SAFE_NAME = /^[a-z][a-z0-9_]*$/;

  it('accepts valid snake_case program names', () => {
    for (const name of ['bazaar_registry', 'my_program_v2', 'x', 'a0']) {
      expect(SAFE_NAME.test(name), `expected ${name} to be safe`).toBe(true);
    }
  });

  it('rejects path-traversal patterns', () => {
    for (const name of ['../evil', '../../etc/passwd', '.hidden', '/absolute']) {
      expect(SAFE_NAME.test(name), `expected ${name} to be rejected`).toBe(false);
    }
  });

  it('rejects TS template-injection patterns', () => {
    for (const name of ['evil}', 'evil\nimport evil', 'Evil', 'UPPER', '0starts_with_digit', '']) {
      expect(SAFE_NAME.test(name), `expected ${name} to be rejected`).toBe(false);
    }
  });
});
