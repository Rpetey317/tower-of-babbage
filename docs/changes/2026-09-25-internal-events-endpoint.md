# Internal events endpoint (M1-02)

`POST /api/internal/events` per
[realtime.md](../components/realtime.md) and contract section 3, at
`apps/web/src/app/api/internal/events/route.ts` (Node runtime,
`force-dynamic`): constant-time `Bearer <SHARED_SECRET>` check, an explicit
`contractVersion` gate returning `400 contract_version_mismatch` before the
Zod `eventBatchSchema` parse (`400 invalid_events` with issues), then a
single transaction that upserts `segment` events on
`(sessionId, runId, chunkIndex, language)`, applies `status` events to
`sessions` (`status`, `currentRunId`, `lastError`, `updatedAt`) and inserts
`log` events into `session_events` (`level: error` also sets
`sessions.lastError`). After commit each event is published on the bus and
latest stats are kept in memory.

New `apps/web/src/server/events/`: `bus.ts` (`publish`/`subscribe` over one
`EventEmitter` on `globalThis`; topics `segments:<id>`, `status:<id>`,
`status:*`), `state.ts` (in-memory latest stats and last-status time per
session, also on `globalThis`), and `watchdog.ts` (`ensureWatchdog` starts a
5 s unref'd interval lazily; `sweepStaleSessions` marks `running`/`starting`
sessions `error` with `status_timeout`, logs a `session_events` row and
publishes on `status:*`). Staleness uses the in-memory last-status time with
`sessions.updatedAt` as fallback so a restarted web app still detects dead
pipelines.

`vitest.config.ts` adds the `~` alias and `test.env` so route tests run
against `DATABASE_URL_TEST` (`babbage_test`); `pnpm test` now spins no extra
services when that database exists.

Verification (`src/app/api/internal/events/route.test.ts`, 7 tests, all
passing): valid batch persists rows and publishes all 4 events on their
topics, wrong bearer returns 401, malformed event returns 400 and writes
nothing, version mismatch returns `contract_version_mismatch`, a duplicate
segment upserts to a single updated row, and the watchdog flips a stale
`running` session to `error` while leaving a fresh one alone. `make lint`
and `make test` pass.
