import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Lot 1 runs entirely without a browser and without network access.
    // Keep it that way: it is the check that the BrowserBackend port (D3) holds.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**'],
    },
  },
});
