// Vitest config for apps/api.
// Uses standard Node pool (not @cloudflare/vitest-pool-workers) so that
// vi.mock() works normally for DB layer isolation. The CF workers pool would
// require a full workerd runtime for every test and prevents vi.mock usage.
// Integration tests against the real deployed worker are deferred to qa-test-eng (Task #58).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/db/schema.ts'],
    },
  },
});
