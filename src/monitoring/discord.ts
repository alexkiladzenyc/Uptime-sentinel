import { PermanentJobError } from '../queue/types.js';

const WEBHOOK_PATTERN =
  /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/;

/**
 * Webhook URLs are user-supplied too, so instead of fetching them through
 * the generic SSRF guard we only ever POST to Discord's own webhook endpoint.
 */
export function isDiscordWebhookUrl(url: string): boolean {
  return WEBHOOK_PATTERN.test(url);
}

export type DiscordSender = (
  webhookUrl: string,
  content: string,
  signal: AbortSignal,
) => Promise<void>;

/** Error carrying the HTTP status, so callers can tell retryable failures apart. */
export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DiscordError';
  }
}

/**
 * Posts a message to a Discord webhook. 429 and 5xx responses throw a
 * retryable error; other 4xx responses (deleted webhook, bad token) throw a
 * PermanentJobError, since retrying them cannot help.
 */
export const sendDiscordMessage: DiscordSender = async (webhookUrl, content, signal) => {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    redirect: 'error',
  });
  if (res.ok) return;
  const detail = (await res.text().catch(() => '')).slice(0, 200);
  const message = `Discord responded ${res.status}${detail ? `: ${detail}` : ''}`;
  if (res.status === 429 || res.status >= 500) throw new DiscordError(message, res.status);
  throw new PermanentJobError(message);
};
