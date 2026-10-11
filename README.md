# Uptime Sentinel

[![CI](https://github.com/alexkiladzenyc/Uptime-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/alexkiladzenyc/Uptime-sentinel/actions/workflows/ci.yml)

An uptime and TLS-certificate monitor. You give it a URL, it checks it on a schedule, records the status code, response time and certificate expiry, opens an incident when the site goes down, and posts to Discord when it goes down, comes back, or the certificate is about to expire.

Honestly, the monitoring is the easy part. What I really wanted to build was the thing underneath it: a background job queue written from scratch on Postgres, with no queue library. It retries with exponential backoff, has a dead-letter queue, and keeps working when workers crash. To prove that last part there's a chaos test that `SIGKILL`s worker processes in the middle of jobs and then checks that nothing got lost or done twice.

## What's in here

- A job queue on plain Postgres: `FOR UPDATE SKIP LOCKED` to claim jobs, leases with heartbeats, fencing tokens so a stalled worker can't overwrite someone else's result, backoff with jitter, a dead-letter queue you can retry from, and graceful shutdown.
- A handler's database writes and the job's completion commit in the same transaction. Alerts go through a transactional outbox, so an incident and its alert job are always written together or not at all.
- SSRF protection that checks the address at the moment the socket connects, which closes the DNS-rebinding gap. Private, loopback, link-local, cloud metadata, CGNAT and the IPv6 transition ranges are all blocked, and every redirect is checked again.
- 147 unit and integration tests against a real Postgres, the chaos test with real worker processes, and a Docker Compose smoke test that monitors an actual website. CI runs all of it on every push.

## Architecture

```mermaid
flowchart LR
    browser([Browser]) -->|REST + static UI| api["API<br/>(Fastify)"]
    api -->|monitors, DLQ retry| db[("Postgres<br/>monitors · jobs · results")]

    subgraph worker["Worker process (run N of them)"]
        scheduler["Scheduler tick<br/>enqueue due checks"]
        loop["Claim loop<br/>SKIP LOCKED + lease"]
        reaper["Reaper<br/>expired leases"]
    end

    scheduler --> db
    loop <-->|claim · heartbeat · complete| db
    reaper --> db
    loop -->|check_monitor| guard["SSRF-safe<br/>HTTP client"] --> sites([Monitored sites])
    loop -->|send_alert| discord([Discord webhook])
```

Everything is built from one Docker image and runs as three kinds of process: the API (which also serves the React dashboard), as many workers as you like, and a one-off migrate step. Workers only coordinate through Postgres. There's no leader and no message broker, and it's safe for every worker to run the scheduler and the reaper at the same time.

### How the queue works

```mermaid
stateDiagram-v2
    direction LR
    [*] --> available: enqueue
    available --> running: claim (attempts += 1, new lease token)
    running --> succeeded: complete
    running --> available: fail, or lease expired (backoff)
    running --> dead: out of attempts, or permanent error
    dead --> available: manual retry
```

A worker claims jobs with a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. That marks them `running`, bumps `attempts`, and gives each one a lease (`lease_expires_at`) and a random lease token.

While a job runs, the worker extends the lease every third of the lease length. If the worker dies, the heartbeats stop and the lease runs out.

Every worker also runs a reaper that looks for `running` jobs with expired leases and puts them back to `available` after a backoff, or moves them to `dead` if that was their last attempt. Attempts are counted when a job is claimed, not when it finishes, so a job that kills its worker every single time still ends up in the dead-letter queue instead of looping forever.

`complete`, `fail` and `heartbeat` all need the current lease token. If a worker stalls past its lease and another worker picks the job up, the first one's late result is rejected.

Handlers that write to the database use `ctx.completeWith(fn)`, which locks the job row, checks the token, runs the handler's writes and marks the job succeeded in one transaction.

What that adds up to: jobs run at least once. Database side effects that go through `completeWith` happen effectively once. Anything outside the database, which here means the Discord message, is at-least-once, so if a worker crashes after Discord accepts a message but before the commit, the message gets sent again. I go through why I settled on that, and what I'd have to do to avoid it, in [`docs/decisions.md`](docs/decisions.md).

### What a check does

`check_monitor` fetches the URL through the SSRF-safe client, outside any transaction. Then, in the transaction that completes the job, it saves the result, updates the monitor's state (a monitor only counts as down after N failures in a row, configurable per monitor), opens or closes the incident, and inserts any alerts along with their `send_alert` jobs. Alerts have a dedupe key like `incident:42:down` or `cert:7:2026-01-31`, so running the same check twice never sends the same alert twice.

### SSRF protection

The server fetches URLs that users type in, so a careless version of this would happily fetch `http://169.254.169.254/` (cloud credentials), `http://localhost:5432`, or anything else on the internal network. Here's what stops that:

- Only `http` and `https` are allowed, and URLs with a username or password in them are refused.
- The hostname is resolved inside the socket's `lookup` hook, so the address I validate is the address that actually gets connected to. A rebinding DNS server doesn't get a chance to swap it in between.
- If any address in the DNS answer isn't public, the whole request is refused. That covers loopback, RFC 1918, link-local and metadata, CGNAT, multicast, reserved and documentation ranges, IPv6 ULA, IPv4-mapped IPv6, NAT64, 6to4 and Teredo.
- IP-literal hosts get the same checks, including the sneaky ones like `http://2130706433/` and `http://0x7f.1/` that both mean `127.0.0.1`. So does every redirect.
- Each request has an overall deadline, at most 5 redirects, and only reads the first 1 MiB of the body.
- Discord webhook URLs have to match Discord's exact format, and they're never shown again once saved.

## Running it

You need Docker with Compose v2.

```sh
git clone https://github.com/alexkiladzenyc/Uptime-sentinel.git
cd Uptime-sentinel
docker compose up --build
```

Then open <http://localhost:3000> and add a URL. Checks start within a few seconds. Compose starts Postgres, runs the migrations, and brings up the API and two workers. `docker compose up --scale worker=4` if you want more.

For Discord alerts, make a webhook (Server Settings → Integrations → Webhooks) and either paste it into a monitor or set it as the default for all of them:

```sh
DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/…' docker compose up --build
```

### Configuration

| Variable                                  | Default  | What it does                                                           |
| ----------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                            | required | Postgres connection string                                             |
| `PORT`                                    | `3000`   | Port for the API and UI                                                |
| `DISCORD_WEBHOOK_URL`                     | unset    | Default webhook for monitors that don't have their own                 |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | unset    | Put the UI and API behind HTTP Basic auth                              |
| `WORKER_CONCURRENCY`                      | `4`      | How many jobs each worker runs at once                                 |
| `WORKER_POLL_INTERVAL_MS`                 | `1000`   | How often an idle worker polls                                         |
| `JOB_LEASE_MS`                            | `30000`  | Lease length, i.e. how long before a crashed worker's jobs get retried |
| `SCHEDULER_ENABLED`                       | `true`   | Whether this worker runs the scheduler                                 |
| `MAX_MONITORS`                            | `200`    | Maximum number of monitors                                             |
| `LOG_LEVEL`                               | `info`   | Pino log level                                                         |

### Running the app without Docker

```sh
npm ci && npm --prefix web ci
cp .env.example .env                      # point DATABASE_URL at a local Postgres
export $(grep -v '^#' .env | xargs)
npm run migrate
npm run dev:api                           # http://localhost:3000 (API)
npm run dev:worker                        # in another terminal
npm --prefix web run dev                  # http://localhost:5173 (UI, proxies /api)
```

## Testing

The tests need a Postgres database whose name ends in `_test`, because the setup wipes it:

```sh
docker run -d --name sentinel-test-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sentinel_test postgres:16-alpine
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/sentinel_test

npm test              # unit + integration (147 tests)
npm run test:chaos    # the chaos test, takes 10-15 seconds
npm run lint && npm run typecheck
```

The unit tests cover the backoff math, the monitor state machine, the IP policy (28 blocked and 5 allowed cases), URL parsing tricks, the Discord client, and the SSRF-safe client against real local HTTP and TLS servers (DNS rebinding, redirects, timeouts, the body cap, certificates).

The integration tests run against a real Postgres: concurrent claims never overlapping, backoff, the dead-letter queue, lease expiry, fencing, transactional completion, the worker itself (retries, timeouts, heartbeats, concurrency limit, graceful stop), the full check → incident → alert path, the scheduler, and the REST API.

### The chaos test

Four worker processes work through 400 jobs while the test `SIGKILL`s a random one every 150–400 ms and starts a replacement. At the end it checks that:

- every job finished as `succeeded` or `dead`, with nothing lost or stuck,
- the poison jobs ended up dead-lettered with all their attempts used,
- every succeeded job's side effect was committed exactly once (the effects table has no unique constraint on purpose, so a duplicate would actually show up),
- the chaos was real: some kills landed on workers that were in the middle of jobs, and those jobs got re-run.

I ran it 5 times in a row locally (Vitest 5, Postgres 16) and it passed every time, with 12–16 kills per run, 11–14 of them hitting a busy worker, 27–32 jobs re-run after a crash, nothing lost and no duplicate effects. To make sure the test could actually fail, I turned the reaper off and ran it again. 42 jobs were left stuck in `running` and it failed, which is what should happen.

### CI

`.github/workflows/ci.yml` runs lint, typecheck, the unit and integration tests, the chaos test, the build, and a Docker Compose smoke test. The smoke test starts the whole stack, adds `https://example.com` as a monitor, waits for a real check to finish, and makes sure the API refuses a metadata-service URL. The first time it ran in CI the check came back up (HTTP 200) with the certificate expiry recorded.

## Project layout

```
src/
  queue/          the job queue: SQL primitives, Worker, backoff, types
  net/            SSRF-safe HTTP client and IP policy
  monitoring/     check logic, state machine, job handlers, scheduler, Discord
  api/            Fastify routes (monitors, queue/DLQ) and app wiring
  bin/            entrypoints: api, worker, migrate
migrations/       plain SQL migrations
web/              React + Vite dashboard
test/
  unit/  integration/  chaos/
docs/decisions.md design decisions and tradeoffs
```

## Limitations

These are the ones I know about. Some I left out on purpose so I could finish the project and properly test what's there.

- It's single-tenant. There are no user accounts, just one shared set of monitors, optionally behind Basic auth. The API has no rate limiting.
- Discord alerts are at-least-once. A worker crashing between Discord accepting a message and the commit means a duplicate message (section 4 of the decisions doc).
- I haven't load-tested or benchmarked the queue, so I'm not claiming any throughput or latency numbers. Polling plus per-job database writes will hit a ceiling a lot sooner than a dedicated broker would.
- Idle workers poll every second and the scheduler ticks every 5 seconds, so a check can start a few seconds late. The schedule also drifts a little, since `next_check_at = now() + interval`.
- Checks are basic: one region, `GET` only, and "up" means a final status of 200–399. No keyword or body checks, custom headers or HEAD requests.
- The certificate it records is the one for the final URL after redirects. If the client rejects a certificate (expired, self-signed) the check fails, but that certificate's expiry date isn't saved.
- It can't go through an HTTP proxy, because the SSRF guard depends on making the connection itself. Ports aren't restricted either, so ports on public hosts can be probed.
- Webhook URLs contain a token and are stored in plain text in Postgres. The API never returns them.
- Succeeded jobs are deleted after 24 hours and check results after 30 days. Dead jobs stay until someone retries or deletes them.
- The React UI has no automated tests. I checked it by hand in headless Chromium in light and dark mode, on desktop and at 390 px wide.
- My development environment had no outbound internet, so every local check ran against local test servers. The real-internet path (public DNS, TLS to a real site) is only verified by the CI smoke test against `https://example.com`. I also couldn't run the multi-stage `docker build` locally because `npm ci` couldn't reach the registry, so the Dockerfile is verified in CI. Locally I tested the same runtime layout with Compose.

## Design decisions

I wrote up every major choice (Postgres as a queue, leases and fencing, polling versus LISTEN/NOTIFY, the outbox, the SSRF approach, raw SQL, how it's tested) with the alternatives I considered and the tradeoffs in [docs/decisions.md](docs/decisions.md).

## License

MIT, see [LICENSE](LICENSE).
