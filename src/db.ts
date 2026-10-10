import pg from 'pg';

// Return bigint columns (bigserial ids, count(*)) as JS numbers. Ids in this
// app will never approach 2^53, and numbers keep the JSON API simple.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

/** Runs `fn` inside BEGIN/COMMIT, rolling back on any error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
