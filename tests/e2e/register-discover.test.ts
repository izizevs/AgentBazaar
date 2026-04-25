/**
 * E2E: register → discover happy path.
 * Hits devnet directly — slow by design. Guarded by E2E=true env var.
 *
 * Run: E2E=true pnpm --filter @agentbazaar/tests test:e2e
 */
import { describe, it } from 'vitest';

const isE2E = process.env.E2E === 'true';

describe.skipIf(!isE2E)('E2E: register → discover', () => {
  it.todo('register a service listing and discover it via RPC fallback');
  // Task #18 — implemented after Task #17 (this file) + Task #14 (backend indexer) land.
});
