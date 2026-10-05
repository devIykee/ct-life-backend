/**
 * Vitest config.
 *
 * Loads the .env file before tests run so loadConfig() sees the same
 * values as the dev stack. Test-only env vars (LOG_LEVEL, etc.) are
 * set in the test file itself.
 */
import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(__dirname, '.env') });

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'packages/**/*.test.ts', 'tools/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      // Forward the loaded .env values to the test workers.
      ...(process.env as Record<string, string>),
    },
  },
});
