# Design decisions

Each section covers what I chose, the alternatives, what the choice costs, and
when I would choose differently.

---

## 1. Postgres as the job queue

**Decision.** Jobs live in a `jobs` table in the same Postgres database as
the application data. No Redis, RabbitMQ, SQS or queue library.

**Alternatives.** Redis with BullMQ/Sidekiq-style libraries; RabbitMQ; a
managed queue (SQS, Cloud Tasks); an off-the-shelf Postgres queue
(pg-boss, Graphile Worker, River).

**Tradeoff.** One fewer piece of infrastructure to run, back up and
monitor. More importantly, jobs can be enqueued _in the same transaction_
as the data change that caused them (see §7), which a separate broker can't
offer without an outbox table and a relay process. The cost: every claim,
heartbeat and completion is a database write. That limits throughput and
adds churn (dead tuples) to a hot table. Postgres also has no push delivery,
so workers poll (see §6).

**When I'd choose differently.** At sustained high throughput (thousands
of jobs per second), or when many services need to consume the same events, a
dedicated broker is the better tool. In production, absent a reason to
build one, I would use a maintained Postgres queue library. This project
builds it from scratch on purpose, to show the mechanics.

---

## 2. Claiming with `FOR UPDATE SKIP LOCKED`

**Decision.** A worker claims jobs with a single `UPDATE … FROM (SELECT …
FOR UPDATE SKIP LOCKED LIMIT n)` statement that flips them to `running`,
increments `attempts`, and issues a lease.

**Alternatives.** Advisory locks keyed on job id; `SELECT … FOR UPDATE`
without `SKIP LOCKED`; optimistic "update where status = 'available'" and
retry on conflict.

**Tradeoff.** `SKIP LOCKED` lets many workers poll at once without blocking
each other or double-claiming a row, in one round trip. Strict FIFO is not
guaranteed under contention: a locked row is skipped, not waited for. That
is fine for this workload. The claim query is backed by a partial index on
`(run_at, id) WHERE status = 'available'`, so it doesn't scan finished jobs.

**Test.** `never hands the same job to two concurrent claimers` runs 10
concurrent claims over 200 jobs and checks that every id comes back exactly once.

---

## 3. Leases, heartbeats and fencing tokens

**Decision.** A claimed job gets `lease_expires_at` (30 s by default) and a
random `lease_token`. The worker heartbeats every lease/3 to extend it. A
reaper, which every worker runs, returns jobs with expired leases to the queue.
Every `complete`/`fail`/`heartbeat` must present the token, and a claim
always issues a new one.

**Alternatives.** Hold the row lock (an open transaction) for the whole
job; use session-level advisory locks that Postgres releases when the
connection dies.

**Tradeoff.** Holding a transaction open while doing a 10-second HTTP call
pins a connection and blocks vacuum. Advisory locks tie job ownership to a
TCP connection, so a network blip loses the job silently, and a hung
process that keeps its connection holds the job forever. Leases work with
any process lifecycle and make crash recovery explicit. Their known
weakness is the _zombie worker_: a process that stalls (GC pause, frozen
VM) past its lease, then wakes up and reports a result for a job someone
else now owns. The fencing token closes that hole, because the stale worker's writes match
zero rows. The cost is recovery latency: a crashed worker's job sits until
its lease expires.

**Test.** `rejects stale workers via the fencing token`, plus the chaos
test (§13).

---

## 4. At-least-once delivery, made effectively-once with transactional completion

**Decision.** The queue guarantees at-least-once execution: a job can run
more than once if a worker dies mid-job. Handlers get
`ctx.completeWith(fn)`, which runs `fn` and marks the job succeeded **in
one transaction**, after locking the job row and checking the lease token.

**Alternatives.** Claim "exactly-once" (impossible across a crash without
cooperation from the side effect); make every handler hand-roll its own
idempotency keys.

**Tradeoff.** For side effects _inside Postgres_, `completeWith` gives
effectively-once results: either the effects and the completion both
commit, or neither does and a retry starts clean. The chaos test checks
that no succeeded job has a duplicate effect row. For side effects
_outside_ Postgres (the Discord POST) there is an unavoidable window:
if the process dies after Discord accepts the message but before the commit,
the retry sends it again. I documented that window rather than claiming it away.

---

## 5. Retries: exponential backoff with equal jitter, attempts counted at claim

**Decision.** `delay = min(max, base · 2^(attempt-1))`, then half of that is
fixed and half random. `attempts` is incremented when a job is _claimed_,
not when it fails. Throwing `PermanentJobError` skips the remaining retries.

**Alternatives.** Fixed delays; full jitter (`random(0, exp)`); counting
attempts on failure.

**Tradeoff.** Equal jitter never retries immediately (unlike full jitter)
but still spreads retries out, so failures that happened together don't retry in
lockstep. Counting at claim time means a _poison pill_, a job that crashes
its worker every time, still uses up its attempts and reaches the
dead-letter queue instead of crashing workers forever. The cost is that a
job also loses an attempt when an unrelated crash kills its worker. The chaos
test gives non-poison jobs 25 attempts for that reason.

---

## 6. Polling instead of LISTEN/NOTIFY

**Decision.** Idle workers poll every second (configurable). A worker polls
again immediately when it filled all its free slots, and wakes early when one
of its own jobs finishes.

**Alternatives.** `LISTEN/NOTIFY` to wake workers on enqueue.

**Tradeoff.** Polling is simple and has no failure mode where a missed
notification leaves a job waiting. The cost is up to ~1 s of pickup latency
and a cheap indexed query per worker per second while idle. Uptime checks
run on 30 s+ intervals, so that latency doesn't matter.

**When I'd choose differently.** For latency-sensitive jobs: NOTIFY to
wake workers, keeping polling as a fallback.

---

## 7. Transactional outbox for alerts

**Decision.** When a check result changes a monitor's state, the same
transaction that completes the check job inserts the check result, updates
the monitor, opens or resolves the incident, inserts the alert row, and
enqueues the `send_alert` job.

**Alternatives.** Send the Discord message directly from the check handler;
enqueue the alert after committing.

**Tradeoff.** No crash can leave an incident without its alert job or an
alert job without its incident. Sending inline would couple check retries
to Discord's availability. Alerts are also deduplicated by a unique
`dedupe_key` (`incident:42:down`, `cert:7:2026-01-31`), so a re-run never
produces a second alert for the same event.

---

## 8. Dead-letter queue as a status, not a separate table

**Decision.** `status = 'dead'` in the same `jobs` table. Dead jobs keep
their `last_error` and can be retried (fresh attempt budget) or deleted
from the UI or API.

**Alternatives.** Move dead jobs to a `dead_jobs` table.

**Tradeoff.** No row copying between tables, retry is a single `UPDATE`, and
the job keeps its id and history. The cost is that dead rows share the hot
table. They're excluded from the claim path by the partial index, and they are
rare by design.

---

## 9. Scheduling inside the workers

**Decision.** Each worker process runs a scheduler tick every 5 s. A
single statement selects due monitors with `FOR UPDATE SKIP LOCKED`,
advances their `next_check_at`, and inserts check jobs with
`ON CONFLICT (dedupe_key) DO NOTHING`.

**Alternatives.** A separate cron process; leader election so only one
scheduler runs; one long-lived "recurring job" per monitor.

**Tradeoff.** No extra process and no leader to elect: any number of
workers can schedule at once without duplicating work (tested with four
concurrent schedulers). The dedupe key also stops checks from piling up when
workers fall behind, because a monitor has at most one pending check. Costs:
checks can start up to one tick (~5 s) late, and `next_check_at = now() +
interval` drifts by that lag instead of staying on a fixed grid.

---

## 10. SSRF protection at connect time

**Decision.** User URLs are fetched with Node's `http(s).request` using a
custom `lookup` function. Node calls it while opening the socket. It resolves
the name, rejects the request if **any** returned address is not
public unicast, and hands Node the validated addresses to connect to. The
same check covers IP literals (which skip `lookup`) and every redirect hop.
Only `http`/`https` are allowed, embedded credentials are rejected, and the
request has a total deadline, a maximum redirect count and a body-size cap.

**Alternatives.** Resolve and check the hostname first, then call `fetch`;
a denylist of private CIDRs; route all checks through an egress proxy with
its own rules.

**Tradeoff.**

- _Check-then-fetch_ has a time-of-check/time-of-use gap. `fetch` resolves DNS
  again, and a rebinding DNS server can return a public address to the
  check and `127.0.0.1` to the connect. Validating inside `lookup` removes
  the gap. There is a test with a resolver that changes its answer between calls.
- An _allowlist_ ("only plain public unicast", using ipaddr.js's range table)
  fails safe: an unusual range such as NAT64 `64:ff9b::/96`, 6to4,
  IPv4-mapped IPv6 or CGNAT is blocked without having to remember it.
- Rejecting the _whole_ DNS answer when one address is private stops
  `[public, private]` record sets from slipping through.
- Discord webhook URLs are user-supplied too. They are not fetched through
  this client at all. They must match Discord's webhook URL pattern
  exactly.

**Costs.** No support for routing checks through an HTTP proxy (the guard
would need to move to the proxy). Ports are not restricted, so a user can
probe ports on _public_ hosts.

---

## 11. Stack: TypeScript, Fastify, raw SQL, React

**Decision.** Node 22 + TypeScript (strict), Fastify for HTTP, `pg` with
hand-written SQL (no ORM), zod for validation, React + Vite for the UI,
Vitest for tests.

**Alternatives.** Express; Prisma/Drizzle/Knex; Go.

**Tradeoff.** These are mainstream choices that a reviewer can read
without learning a framework. The queue depends on Postgres-specific SQL
(`SKIP LOCKED`, partial unique indexes with `ON CONFLICT`, CTE-based
updates) that ORMs either can't express or hide. Raw SQL keeps it visible
and reviewable. The cost is no generated types for query results; row
types are declared by hand next to each query.

---

## 12. Tests against a real Postgres, not mocks

**Decision.** Integration tests run against a real Postgres 16 (a service
container in CI). A global setup recreates the schema, and test files run
serially against it.

**Alternatives.** Mocking `pg`; Testcontainers; pg-mem.

**Tradeoff.** The interesting behaviour is in Postgres (locking, partial
indexes, `ON CONFLICT` inference, transaction semantics), so mocking it would
test nothing. Testcontainers would remove the external database
requirement, but adds Docker-in-test complexity. A `DATABASE_URL` with a
safety check (the database name must end in `_test`, because the setup wipes it)
is simpler and works the same locally and in CI.

---

## 13. Chaos testing with real processes and SIGKILL

**Decision.** The chaos test spawns real worker processes and kills them with
`SIGKILL` (no shutdown hooks run) every 150–400 ms while they drain 400
jobs, then checks the invariants: nothing lost or stuck, poison jobs
dead-lettered, each succeeded job's effect committed exactly once, and
crash recovery actually happened (kills hit workers holding running jobs,
and those jobs were re-run).

**Alternatives.** Simulating crashes in-process by abandoning promises or
closing pool connections.

**Tradeoff.** Real processes and a real `SIGKILL` exercise what in-process
simulation can't: connections dropped mid-transaction, heartbeats that
just stop, jobs leased to a process that no longer exists. The cost is a
~10 s test and some nondeterminism. The test asserts invariants rather
than exact numbers, so its results don't depend on timing. To check that
it can fail, I disabled the reaper and ran it: 42 jobs were left stuck in
`running` and the test failed, as it should.

---

## 14. Migrations: a small runner instead of a library

**Decision.** A ~50-line runner applies `migrations/NNN_name.sql` in order,
each in its own transaction, recorded in `schema_migrations`, under a
Postgres advisory lock so concurrent containers can't race.

**Alternatives.** node-pg-migrate, Flyway, Prisma Migrate.

**Tradeoff.** Plain SQL files are easy to review, and the runner has no
dependencies. There are no down-migrations. For a team project I'd use an
established tool.

---

## 15. Auth: optional HTTP Basic, single tenant

**Decision.** The app is single-tenant. Setting `BASIC_AUTH_USER` and
`BASIC_AUTH_PASSWORD` protects the UI and API (constant-time comparison).
`/api/health` stays open for health checks.

**Alternatives.** User accounts with sessions; OAuth.

**Tradeoff.** Accounts would add a lot of code without exercising anything
the project is about. Basic auth is enough to put a personal instance on
the internet over TLS. Multi-tenancy is listed under Limitations in the README.
