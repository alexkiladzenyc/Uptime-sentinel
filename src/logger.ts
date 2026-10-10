import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, name: string): Logger {
  return pino({ level, name });
}
