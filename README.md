# Uptime Sentinel

[![CI](https://github.com/alexkiladzenyc/Uptime-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/alexkiladzenyc/Uptime-sentinel/actions/workflows/ci.yml)

**Uptime and TLS-certificate monitoring, running on a crash-safe job queue built from scratch on Postgres.**

<!-- TODO: replace with a real screenshot, e.g. docs/screenshot.png -->

> 📸 **Screenshot:** _coming soon_
>
> 🌐 **Live demo:** _coming soon_

Add a URL and Uptime Sentinel checks it on a schedule. It records status codes,
response times and certificate expiry, opens an incident when a site goes down,
and posts to a Discord webhook when the site goes down, comes back up, or its
TLS certificate is close to expiring.

The monitoring app showcases the part underneath: a **background job system
written from scratch on Postgres, with no queue libraries**. It survives
worker crashes, retries with exponential backoff, has a dead-letter queue, and
is tested by a chaos test that `SIGKILL`s worker processes mid-job and checks
that nothing is lost.

## Highlights

- **Postgres job queue**: `FOR UPDATE SKIP LOCKED` claims, leases with heartbeats,
  fencing tokens against zombie workers, exponential backoff with jitter, a
  dead-letter queue with manual retry, and graceful shutdown.
- **Effectively-once database effects**: a handler's writes and the job's
  completion commit in one transaction. Alerts use a transactional outbox, so
  an incident and its alert job are always written together.
- **SSRF protection**: user URLs are validated at socket-connect time, which
  closes the DNS-rebinding gap. Private, loopback, link-local, metadata, CGNAT
  and IPv6 transition ranges are blocked, and every redirect hop is
  re-checked.
- **Tests against a real Postgres**: 147 unit and integration tests, plus a
  chaos test with real worker processes. All of them run in CI on every push,
  along with a Docker Compose smoke test that checks a real website.

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

There are three process types, all built from one Docker image: the **API** (also
serves the React UI), any number of **workers**, and a one-shot **migrate**
container. Workers coordinate only through Postgres. There is no leader and no
broker, and every worker runs the scheduler and the reaper safely.

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

1. **Claim.** A worker runs one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
LOCKED)`. It marks jobs `running`, increments `attempts`, and sets a
   **lease** (`lease_expires_at`) plus a random **lease token**.
2. **Heartbeat.** While a job runs, the worker extends its lease every
   lease/3. If the worker dies, the heartbeats stop.
3. **Reap.** Every worker periodically moves `running` jobs with expired leases
   back to `available` (after a backoff) or to `dead` if that was their last
   attempt. Because attempts are counted at claim time, a job that crashes its
   worker every time still reaches the dead-letter queue.
4. **Fence.** `complete`, `fail` and `heartbeat` all require the current lease
   token. A worker that stalled past its lease (a "zombie") can't overwrite the
   result of the worker that took the job over.
5. **Complete in a transaction.** `ctx.completeWith(fn)` locks the job row,
   checks the token, runs the handler's writes, and marks the job succeeded,
   all in one transaction.

**Delivery guarantee:** at-least-once execution. Database side effects are
effectively-once when they go through `completeWith`. Side effects outside
the database (the Discord POST) are at-least-once: a crash between Discord
accepting a message and the commit means that message is sent again. See
[`docs/decisions.md`](docs/decisions.md) for the reasoning and the
alternatives.

### What a check does

`check_monitor` fetches the URL through the SSRF-safe client (outside any
transaction). Then, in the transaction that completes the job, it stores the
result, updates the monitor's state (it goes down only after N consecutive
failures, set per monitor), opens or resolves the incident, and inserts any
alert rows **plus their `send_alert` jobs**. Alerts are deduplicated by key
(`incident:42:down`, `cert:7:2026-01-31`), so a re-run never alerts twice for
the same event.

### SSRF protection

Users submit URLs that the server fetches, so a naive implementation could be
used to reach `http://169.254.169.254/` (cloud credentials),
`http://localhost:5432` or anything else on the internal network.

- Only `http`/`https` are allowed, and URLs with embedded credentials are refused.
- Hostnames are resolved **inside the socket's `lookup` hook**, so the address
  that is validated is the address that gets connected to. A rebinding DNS
  server can't hand out a different address between the check and the connect.
- If **any** address in the DNS answer is non-public, the request is refused.
  Only plain public unicast passes. This blocks loopback, RFC 1918, link-local
  and metadata, CGNAT, multicast, reserved and documentation ranges, IPv6
  ULA, IPv4-mapped IPv6, NAT64, 6to4 and Teredo.
- IP-literal hosts (including `http://2130706433/` and `http://0x7f.1/`, which
  normalise to `127.0.0.1`) and every redirect hop go through the same checks.
- Each request has a total deadline, a maximum of 5 redirects, and a 1 MiB
  limit on how much of the body is read.
- Discord webhook URLs must match Discord's exact webhook URL format and are
  never shown again after they're saved.

## Running it

**Requirements:** Docker with Compose v2.

```sh
git clone https://github.com/alexkiladzenyc/Uptime-sentinel.git
cd Uptime-sentinel
docker compose up --build
```

Open <http://localhost:3000> and add a URL. Checks start within a few
seconds. This starts Postgres, runs migrations, and starts the API and two
worker replicas (`docker compose up --scale worker=4` for more).

To get alerts in Discord, create a webhook (_Server Settings → Integrations →
Webhooks_) and either paste it into a monitor or set it as the default:

```sh
DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/…' docker compose up --build
```

### Configuration

| Variable                                  | Default    | Purpose                                                      |
| ----------------------------------------- | ---------- | ------------------------------------------------------------ |
| `DATABASE_URL`                            | (required) | Postgres connection string                                   |
| `PORT`                                    | `3000`     | API / UI port                                                |
| `DISCORD_WEBHOOK_URL`                     | unset      | Default webhook for monitors without their own               |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | unset      | Protect the UI and API with HTTP Basic auth                  |
| `WORKER_CONCURRENCY`                      | `4`        | Jobs each worker runs at once                                |
| `WORKER_POLL_INTERVAL_MS`                 | `1000`     | Idle poll interval                                           |
| `JOB_LEASE_MS`                            | `30000`    | Lease length; a crashed worker's jobs are retried after this |
| `SCHEDULER_ENABLED`                       | `true`     | Run the scheduler tick in this worker                        |
| `MAX_MONITORS`                            | `200`      | Upper bound on monitors                                      |
| `LOG_LEVEL`                               | `info`     | Pino log level                                               |

### Local development (without Docker for the app)

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

Tests need a Postgres database whose name ends in `_test` (the setup wipes it):

```sh
docker run -d --name sentinel-test-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sentinel_test postgres:16-alpine
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/sentinel_test

npm test              # unit + integration (147 tests)
npm run test:chaos    # chaos test, ~10-15 s
npm run lint && npm run typecheck
```

| Suite           | What it covers                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Unit**        | Backoff math; the monitor state machine; the IP policy (28 blocked and 5 allowed cases); URL parsing tricks; the SSRF-safe client against real local HTTP/TLS servers (DNS rebinding, redirect hops, timeouts, body cap, certificates); the Discord client                                 |
| **Integration** | Queue primitives against real Postgres (concurrent claims never overlap, backoff, DLQ, lease expiry, fencing, transactional completion); the Worker (retries, timeouts, heartbeats, concurrency limit, graceful stop); end-to-end checks → incidents → alerts; the scheduler; the REST API |
| **Chaos**       | 4 worker processes drain 400 jobs while the test `SIGKILL`s a random worker every 150–400 ms and starts a replacement                                                                                                                                                                      |

**Chaos test invariants:** every job ends `succeeded` or `dead`, with none lost
or stuck. Poison jobs are dead-lettered with their attempts used up. Every
succeeded job's side effect is committed **exactly once** (the effects table
deliberately has no unique constraint, so a duplicate would show up). The test
also asserts that the chaos was real: some kills hit workers holding running
jobs, and those jobs were re-run.

**Results so far.** In 5 consecutive local runs (Vitest 5, Postgres 16), every
run passed: 12–16 kills per run, 11–14 of them hitting a worker with running
jobs, 27–32 jobs re-run after a crash, 0 lost, 0 duplicate effects. The test
also runs in CI on every push. To check that the test can fail, I disabled the
reaper and ran it: 42 jobs were left stuck in `running` and it failed, as it should.

**CI** (`.github/workflows/ci.yml`) runs lint, typecheck, unit and integration
tests, the chaos test, the build, and a Docker Compose smoke test. The smoke
test brings the stack up, adds `https://example.com` as a monitor, waits for a
real check to complete, and confirms the API rejects a metadata-service URL. On
the first CI run, that check came back up (HTTP 200) with the certificate
expiry recorded.

## Project layout

```
src/
  queue/          The job queue: SQL primitives, Worker, backoff, types
  net/            SSRF-safe HTTP client and IP policy
  monitoring/     Check logic, state machine, job handlers, scheduler, Discord
  api/            Fastify routes (monitors, queue/DLQ) and app wiring
  bin/            Entrypoints: api, worker, migrate
migrations/       Plain SQL migrations
web/              React + Vite dashboard
test/
  unit/  integration/  chaos/
docs/decisions.md Design decisions and tradeoffs
```

## Limitations

These are the ones I know about. Some were cut deliberately to keep the
project finished and verifiable.

- **Single tenant.** There are no user accounts: one shared set of monitors,
  optionally behind HTTP Basic auth. The API has no rate limiting.
- **Discord alerts are at-least-once.** A worker crash between Discord
  accepting a message and the commit causes a duplicate message (see §4 of
  the decisions doc).
- **No performance claims.** I haven't load-tested or benchmarked the queue,
  so I make no throughput or latency claims. Polling plus per-job database
  writes will hit a ceiling well before a dedicated broker would.
- **Pickup latency.** Idle workers poll every second, and the scheduler ticks
  every 5 seconds, so a check can start a few seconds after it's due. The
  schedule also drifts (`next_check_at = now() + interval`).
- **Checks are simple.** One region, `GET` only, and up means a final status of
  200–399. No keyword or body assertions, custom headers or HEAD requests.
- **Certificate handling.** The recorded certificate is the one for the final
  URL after redirects. Certificates the client rejects (expired, self-signed)
  make the check fail, but their expiry date isn't recorded.
- **No egress proxy support.** The SSRF guard relies on making the connection
  itself, so checks can't go through an HTTP proxy without moving the guard
  there. Ports aren't restricted, so public hosts' ports can be probed.
- **Secrets at rest.** Webhook URLs (which contain a token) are stored in
  plaintext in Postgres. The API never returns them.
- **Retention.** Succeeded jobs are pruned after 24 hours and check results
  after 30 days. Dead jobs stay until someone retries or deletes them.
- **UI tests.** The React UI has no automated tests. I checked it manually in
  headless Chromium (light/dark mode, desktop and 390 px mobile).
- **Verification gaps.** I developed this in a sandbox without outbound
  internet, so all local checks used local test servers. The real-internet
  path (DNS, TLS to a public site) is verified only by the CI smoke test
  against `https://example.com`. I couldn't run the multi-stage `docker build`
  locally either (no registry access for `npm ci`), so the Dockerfile is
  verified by CI. Locally I tested the same runtime layout with Compose.

## Design decisions

Every major choice (Postgres as a queue, leases and fencing, polling versus
LISTEN/NOTIFY, the outbox, SSRF strategy, raw SQL, testing approach) is
written up with the alternatives and tradeoffs in
[**docs/decisions.md**](docs/decisions.md).

## License

MIT, see [LICENSE](LICENSE).
