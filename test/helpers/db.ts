import { createPool, type Pool } from '../../src/db.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/sentinel_test';

export function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run destructive tests against "${dbName}" (name must end in _test)`,
    );
  }
}

export function testPool(max = 10): Pool {
  assertTestDatabase(TEST_DATABASE_URL);
  return createPool(TEST_DATABASE_URL, max);
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE jobs, monitors, check_results, incidents, alerts RESTART IDENTITY CASCADE',
  );
}
