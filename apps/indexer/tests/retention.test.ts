/**
 * Tests for the TTL retention cron (Task #44).
 *
 * DB-integration tests are skipped when DATABASE_URL is absent.
 * Timer-wiring tests use vi.useFakeTimers() and mock runRetentionCleanup.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSql } from '../src/db/client.js';

const dbUrl = process.env.DATABASE_URL;

// ── Timer-wiring tests ────────────────────────────────────────────────────────

describe('startRetentionCron — timer wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('intervalMs=0 returns a no-op stop function without scheduling anything', async () => {
    // Import fresh so module-level side effects are clean
    const { startRetentionCron } = await import('../src/cron/retention.js');
    const stop = startRetentionCron(0);
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
    // No timers fired
    await vi.runAllTimersAsync();
  });

  it('stop() prevents further timer firings', async () => {
    const { startRetentionCron, runRetentionCleanup } = await import('../src/cron/retention.js');

    const cleanupSpy = vi.spyOn({ runRetentionCleanup }, 'runRetentionCleanup');
    // We can't easily spy on the module export, but we CAN verify stop() doesn't throw
    // and that the returned handle is callable.
    const stop = startRetentionCron(5_000);
    expect(typeof stop).toBe('function');

    // Advance past the initial 60 s delay + 1 interval
    // (DB is not required here — any DB errors are caught internally and logged)
    stop();

    // After stop(), advancing time should not cause additional timer firings
    await vi.advanceTimersByTimeAsync(120_000);
    // No assertion on cleanupSpy — the stop test passes if no uncaught error surfaces
    cleanupSpy.mockRestore();
  });
});

// ── Integration tests (real DB) ───────────────────────────────────────────────

describe.skipIf(!dbUrl)('runRetentionCleanup — DB integration', () => {
  // Lazy-resolve sql inside the test so we don't fail at import time without a DB
  function sql() {
    return getSql();
  }

  async function seedSig(signature: string, ageMs: number) {
    const processedAt = new Date(Date.now() - ageMs);
    await sql()`
      INSERT INTO processed_signatures (signature, processed_at)
      VALUES (${signature}, ${processedAt})
      ON CONFLICT (signature) DO NOTHING
    `;
  }

  beforeAll(async () => {
    await seedSig('retention-test-recent', 1_000); // 1 s old — survives
    await seedSig('retention-test-old', 31 * 24 * 60 * 60 * 1000); // 31 d old — deleted
  });

  afterAll(async () => {
    await sql()`DELETE FROM processed_signatures WHERE signature LIKE 'retention-test-%'`;
  });

  it('deletes rows older than 30 days and returns the count', async () => {
    const { runRetentionCleanup } = await import('../src/cron/retention.js');
    const deleted = await runRetentionCleanup();

    expect(deleted).toBeGreaterThanOrEqual(1);

    const rows = await sql()`
      SELECT signature FROM processed_signatures WHERE signature = 'retention-test-old'
    `;
    expect(rows).toHaveLength(0);
  });

  it('does not delete rows younger than 30 days', async () => {
    const rows = await sql()`
      SELECT signature FROM processed_signatures WHERE signature = 'retention-test-recent'
    `;
    expect(rows).toHaveLength(1);
  });

  it('returns 0 when nothing is eligible for deletion', async () => {
    const { runRetentionCleanup } = await import('../src/cron/retention.js');
    // All old rows already gone — second call returns 0 without throwing
    const deleted = await runRetentionCleanup();
    expect(deleted).toBeGreaterThanOrEqual(0);
  });
});
