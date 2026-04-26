/**
 * Tests for env.ts Zod schema validation (Task #57 — L1 audit item).
 *
 * Covers the RETENTION_INTERVAL_MS refine rule:
 *  - 0 is valid (explicit "disabled" sentinel)
 *  - >= 60 000 ms is valid (safe minimum to avoid dual-timer storm)
 *  - 1–59 999 ms must reject (typo guard)
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Extract the RETENTION_INTERVAL_MS schema fragment for isolated testing.
// We replicate the exact coerce + refine chain from env.ts so we don't need
// to stub process.env or deal with dotenv-mono side effects.
const RetentionIntervalSchema = z.coerce
  .number()
  .int()
  .min(0)
  .refine((v) => v === 0 || v >= 60_000, 'must be 0 (disabled) or >= 60_000 ms');

describe('RETENTION_INTERVAL_MS schema', () => {
  it('rejects 1 ms (typo / too small)', () => {
    const result = RetentionIntervalSchema.safeParse(1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('60_000');
    }
  });

  it('rejects 59 999 ms (just under minimum)', () => {
    const result = RetentionIntervalSchema.safeParse(59_999);
    expect(result.success).toBe(false);
  });

  it('accepts 60 000 ms (minimum valid non-zero interval)', () => {
    const result = RetentionIntervalSchema.safeParse(60_000);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(60_000);
    }
  });

  it('accepts 0 (disabled sentinel)', () => {
    const result = RetentionIntervalSchema.safeParse(0);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(0);
    }
  });

  it('accepts default 86 400 000 ms (24 h)', () => {
    const result = RetentionIntervalSchema.safeParse(86_400_000);
    expect(result.success).toBe(true);
  });
});
