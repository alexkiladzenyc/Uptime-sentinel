import { pino } from 'pino';

export const silentLogger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });
