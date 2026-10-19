import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    pool: 'threads',
    // Prepara la base de integración (si TEST_DATABASE_URL está definida).
    globalSetup: ['tests/integration/global-setup.ts'],
    testTimeout: 20_000,
  },
});
