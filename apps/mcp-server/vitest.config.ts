// Vitest config for apps/mcp-server.
// Uses standard Node pool so that vi.mock() works normally for API client isolation.
// Integration tests against the deployed worker are deferred to qa-test-eng.
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
    },
  },
});
