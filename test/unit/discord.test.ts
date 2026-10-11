import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DiscordError,
  isDiscordWebhookUrl,
  sendDiscordMessage,
} from '../../src/monitoring/discord.js';
import { PermanentJobError } from '../../src/queue/types.js';

const VALID =
  'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-0123456789';

describe('isDiscordWebhookUrl', () => {
  it('accepts Discord webhook URLs', () => {
    expect(isDiscordWebhookUrl(VALID)).toBe(true);
    expect(isDiscordWebhookUrl(VALID.replace('discord.com', 'discordapp.com'))).toBe(true);
    expect(isDiscordWebhookUrl(VALID.replace('discord.com', 'canary.discord.com'))).toBe(true);
  });

  it.each([
    VALID.replace('https:', 'http:'),
    VALID.replace('discord.com', 'discord.com.evil.test'),
    VALID.replace('discord.com', 'evil.test/discord.com'),
    `${VALID}?wait=true`,
    'https://discord.com/api/webhooks/123/short',
    'http://169.254.169.254/latest/meta-data/',
  ])('rejects %s', (url) => {
    expect(isDiscordWebhookUrl(url)).toBe(false);
  });
});

describe('sendDiscordMessage', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function fakeDiscord(status: number) {
    const bodies: unknown[] = [];
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(status).end(status >= 400 ? 'nope' : undefined);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    return { url, bodies };
  }

  const signal = () => new AbortController().signal;

  it('posts the message with mentions disabled', async () => {
    const { url, bodies } = await fakeDiscord(204);
    await sendDiscordMessage(url, 'hello @everyone', signal());
    expect(bodies).toEqual([{ content: 'hello @everyone', allowed_mentions: { parse: [] } }]);
  });

  it('throws a retryable error on 429 and 5xx', async () => {
    for (const status of [429, 503]) {
      const { url } = await fakeDiscord(status);
      const err = await sendDiscordMessage(url, 'x', signal()).catch((e) => e);
      expect(err).toBeInstanceOf(DiscordError);
      expect(err.status).toBe(status);
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it('throws a permanent error on other 4xx', async () => {
    const { url } = await fakeDiscord(404);
    await expect(sendDiscordMessage(url, 'x', signal())).rejects.toBeInstanceOf(PermanentJobError);
  });
});
