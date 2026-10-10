import { migrate } from '../../src/migrate.js';
import { testPool } from './db.js';

/** Recreates the test schema from scratch, then applies all migrations. */
export default async function setup(): Promise<void> {
  const pool = testPool(1);
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
