import { defineConfig } from 'vitest/config';

// Integration and chaos tests share one Postgres database, so their files
// run one at a time. TEST_DATABASE_URL must name a database ending in "_test";
// the global setup wipes it.
export default defineConfig({
  test: {
    // Show console output from passing tests too (the chaos test prints its run summary).
    silent: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/helpers/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'chaos',
          include: ['test/chaos/**/*.test.ts'],
          globalSetup: ['test/helpers/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 180_000,
        },
      },
    ],
  },
});
