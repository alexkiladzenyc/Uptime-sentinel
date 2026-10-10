import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BASIC_AUTH_USER: optionalString,
  BASIC_AUTH_PASSWORD: optionalString,
  DISCORD_WEBHOOK_URL: optionalString,
  MAX_MONITORS: z.coerce.number().int().positive().default(200),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  JOB_LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WEB_DIST_DIR: optionalString,
});

export type Config = z.output<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const config = parsed.data;
  if (Boolean(config.BASIC_AUTH_USER) !== Boolean(config.BASIC_AUTH_PASSWORD)) {
    throw new Error('Set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD, or neither.');
  }
  return config;
}
