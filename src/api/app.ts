import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Pool } from '../db.js';
import type { AddressPolicy, Resolver } from '../net/safe-fetch.js';
import { ApiError } from './errors.js';
import { monitorRoutes } from './monitors.js';
import { queueRoutes } from './queue.js';

export interface AppOptions {
  pool: Pool;
  /** Pino log level for request logs; omit to disable logging (tests). */
  logLevel?: string;
  basicAuth?: { user: string; password: string };
  maxMonitors?: number;
  webDistDir?: string;
  resolver?: Resolver;
  addressPolicy?: AddressPolicy;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logLevel ? { level: opts.logLevel, name: 'api' } : false,
    bodyLimit: 64 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal server error' });
  });

  if (opts.basicAuth) {
    const expected = Buffer.from(
      `Basic ${Buffer.from(`${opts.basicAuth.user}:${opts.basicAuth.password}`).toString('base64')}`,
    );
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/api/health') return;
      const given = Buffer.from(req.headers.authorization ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return reply
          .code(401)
          .header('www-authenticate', 'Basic realm="Uptime Sentinel", charset="UTF-8"')
          .send({ error: 'authentication required' });
      }
    });
  }

  app.get('/api/health', async (_req, reply) => {
    try {
      await opts.pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(monitorRoutes, {
    pool: opts.pool,
    maxMonitors: opts.maxMonitors ?? 200,
    resolver: opts.resolver,
    addressPolicy: opts.addressPolicy,
  });
  await app.register(queueRoutes, { pool: opts.pool });

  const webDist = opts.webDistDir;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    // Client-side routing: unknown page paths get the SPA shell. Paths that
    // look like files (/assets/x.js) 404 instead, so a stale asset URL fails
    // loudly rather than being answered with HTML.
    app.setNotFoundHandler((req, reply) => {
      const pathname = req.url.split('?')[0] ?? '';
      const isPage = !pathname.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(pathname);
      if (req.method === 'GET' && isPage) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  }

  return app;
}
