import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { migrate } from '../migrate.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL, 1);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
