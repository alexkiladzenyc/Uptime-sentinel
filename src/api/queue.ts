import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../db.js';
import * as queue from '../queue/queue.js';
import type { Job } from '../queue/types.js';
import { ApiError, parseBody, parseId } from './errors.js';

const listQuery = z.object({
  status: z.enum(['available', 'running', 'succeeded', 'dead']).default('dead'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function toDto(j: Job) {
  return {
    id: j.id,
    type: j.type,
    payload: j.payload,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    runAt: j.run_at,
    lockedBy: j.locked_by,
    lastError: j.last_error,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    finishedAt: j.finished_at,
  };
}

export async function queueRoutes(app: FastifyInstance, opts: { pool: Pool }) {
  const { pool } = opts;

  app.get('/api/queue/stats', async () => queue.stats(pool));

  app.get('/api/queue/jobs', async (req) => {
    const q = parseBody(listQuery, req.query);
    const jobs = await queue.listJobs(pool, q.status, q.limit);
    return { jobs: jobs.map(toDto) };
  });

  app.post('/api/queue/jobs/:id/retry', async (req) => {
    const id = parseId(req.params);
    if (!(await queue.retryDead(pool, id))) {
      throw new ApiError(
        409,
        'job is not in the dead-letter queue, or an equivalent job is already queued',
      );
    }
    return { ok: true };
  });

  app.delete('/api/queue/jobs/:id', async (req, reply) => {
    const id = parseId(req.params);
    const { rowCount } = await pool.query(`DELETE FROM jobs WHERE id = $1 AND status = 'dead'`, [
      id,
    ]);
    if (rowCount === 0) throw new ApiError(404, 'no dead job with that id');
    return reply.code(204).send();
  });
}
