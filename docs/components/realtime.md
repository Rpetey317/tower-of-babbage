# Real-time delivery

Location: `apps/web/src/app/api/internal/events/route.ts`,
`apps/web/src/server/events/`, `apps/web/src/server/api/routers/segments.ts`.

Path of a segment: pipeline batch -> events endpoint -> Postgres upsert ->
in-process bus -> tRPC SSE subscription -> browser.

## Events endpoint

`POST /api/internal/events` (contract section 3). Node runtime, `force-dynamic`.

1. Check the bearer against `SHARED_SECRET` (constant-time compare).
2. Parse with the Zod `EventBatch` schema; reject the whole batch on any error.
3. In one transaction: upsert `segment` events on
   `(sessionId, runId, chunkIndex, language)`, apply `status` events to
   `sessions`, insert `log` events into `session_events`.
4. After commit, publish each event on the bus.

Transaction first, publish second: a subscriber that misses an event because
of a race can always recover from the database.

## Bus

`server/events/bus.ts` exposes `publish(topic, event)` and
`subscribe(topic): AsyncIterable`. Topics: `segments:<sessionId>`,
`status:<sessionId>`, `status:*`. The implementation is an `EventEmitter` stored
on `globalThis` so Next.js dev reloads and route handlers share one instance.
Replacing it with Redis pub/sub is confined to this file when the web app
needs more than one instance.

## tRPC surface

Router `sessions` (public):

| Procedure | Returns |
| --- | --- |
| `list` | Sessions with `slug`, `title`, `room`, `roomColor`, `sourceLanguage`, `targetLanguages`, `status` |
| `bySlug({ slug })` | One session or `NOT_FOUND` |

Router `segments` (public):

| Procedure | Returns |
| --- | --- |
| `recent({ sessionId, languages, limit = 50 })` | Latest segments of the current run for the requested languages, ordered by `chunkIndex` |
| `onSegment({ sessionId, languages, lastEventId? })` | Subscription over SSE |

The subscription uses tRPC v11 `httpSubscriptionLink` and `tracked(id, data)`
with `id = "<runId>:<chunkIndex>:<language>"`. On reconnect the client sends
`lastEventId`; the server first yields segments from the database with a higher
`chunkIndex` in the same run, then attaches to the bus. A run change (new
`runId`) is signaled by a `status` item in the same stream (id
`<runId>:status`, which catch-up parses as "replay the run from the start") so
the client can clear its view. SSE keepalive ping every 15 s.

Router `admin` (protected) adds `onStatus()` streaming `status` and `log`
events for all sessions to the monitoring view; see
[admin-panel.md](admin-panel.md).

## Client model

The audience page keeps a `Map<chunkIndex, { original?, translations: Map<language, text> }>`
so that translation segments arriving after originals (`asr_then_text` mode) fill
in without reordering. Rendering shows the last N chunks; older ones are
evicted from the map.

## Watchdog

`server/events/watchdog.ts` runs a 5 s interval (started lazily, kept on
`globalThis`) that marks sessions `running`/`starting` as `error` with code
`status_timeout` when no status event arrived for 15 s, and publishes the
change on `status:*`.

## Verification

- Vitest: events route with a valid batch (rows exist, bus received 4 events),
  invalid bearer (401), malformed event (400, no rows written).
- Vitest: `tracked` id encoding and `lastEventId` catch-up query.
- `make smoke`: replay through the mock provider, `curl -N` on the SSE endpoint
  shows segments within 2 s of emission.
