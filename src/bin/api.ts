import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../api/app.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const defaultWebDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const app = await buildApp({
  pool,
  logLevel: config.LOG_LEVEL,
  maxMonitors: config.MAX_MONITORS,
  webDistDir: config.WEB_DIST_DIR ?? defaultWebDist,
  basicAuth:
    config.BASIC_AUTH_USER && config.BASIC_AUTH_PASSWORD
      ? { user: config.BASIC_AUTH_USER, password: config.BASIC_AUTH_PASSWORD }
      : undefined,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
