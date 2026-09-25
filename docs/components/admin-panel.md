# Admin panel

Location: `apps/web/src/app/admin/`, router `admin` in
`apps/web/src/server/api/routers/admin.ts`.

For the production team: create sessions, start and stop them, feed audio,
watch health, manage glossaries, export transcripts. Desktop first; the
operator page must also work on a laptop next to the stage.

## Authentication

- `/admin/login`: one password field checked against `ADMIN_PASSWORD`.
- Success sets an HttpOnly, SameSite=Lax cookie `tob_admin` containing
  `expiry.signature` (HMAC-SHA256 with `AUTH_SECRET`), valid 12 hours.
- `middleware.ts` redirects unauthenticated requests under `/admin` (except
  `/admin/login`) to the login page. tRPC `admin.*` procedures use a
  `protectedProcedure` that verifies the same cookie.
- Upgrade path (backlog): Better Auth with per-user accounts and roles; the
  `protectedProcedure` boundary stays the same.

## Routes

| Route | Content |
| --- | --- |
| `/admin` | Monitoring dashboard: table of all sessions with status pill, room, languages, `audioReceivedMs`, `queueDepth`, latency p50/p95, `chunksDropped`, `lastError`, start/stop buttons. Pipeline health from `GET /healthz` (provider, endpoints, active sessions). Live via `admin.onStatus`. |
| `/admin/sessions/new` | Form: title, slug (auto from title, editable), room, room color, source language, target languages (ordered multi-select), source type and its config, translation mode. |
| `/admin/sessions/[id]` | Edit form, start/stop, links to audience page, overlay page and operator page, recent `session_events` log (last 100), export buttons (SRT/VTT/TXT per language), session glossary editor. |
| `/admin/sessions/[id]/operator` | Microphone capture page described in [ingest.md](ingest.md). Big status, level meter, `audioReceivedMs`, reconnect button. |
| `/admin/glossary` | Global glossary editor. |

## tRPC `admin` router

| Procedure | Effect |
| --- | --- |
| `sessions.create(input)`, `sessions.update({ id, patch })`, `sessions.delete({ id })` | CRUD; delete cascades segments and events; refused while `running` |
| `sessions.start({ id })` | Generates `runId`, sets `starting`, `currentRunId`, `startedAt`; calls `POST /v1/sessions/{id}/start` with languages, source, mode and merged glossary (session terms then global). On pipeline error sets `error` with the message. |
| `sessions.stop({ id })` | Sets `stopping`, calls `POST /v1/sessions/{id}/stop` |
| `ingestToken({ sessionId })` | Returns a 10-minute ingest token (contract section 5) |
| `glossary.list({ sessionId? })`, `glossary.upsert(term)`, `glossary.addMany({ sessionId?, text })`, `glossary.delete({ id })` | Terms, global (`sessionId` null) or per session; `addMany` parses bulk paste (`term = translation` per line, duplicates skipped). Mutations return `liveSync` and push the merged list to `PUT /v1/sessions/{id}/glossary` for every session with an active run (best effort until M4-02) |
| `events.recent({ sessionId, limit })` | `session_events` rows |
| `pipelineHealth()` | Proxies `GET /healthz` |
| `onStatus()` | Subscription: `status` and `log` events for all sessions plus watchdog changes |

Start and stop are the only places that call the pipeline; both are idempotent
on the web side (starting an already `running` session returns the current
run).

## Monitoring semantics

| Column | Source | Alarm |
| --- | --- | --- |
| Status | `sessions.status` | `error` red, `starting`/`stopping` orange |
| Audio | `stats.audioReceivedMs` compared to wall time since `startedAt` | Drift above 10 s means the producer is stalling |
| Queue | `stats.queueDepth` | Above 2 sustained: inference too slow for this session |
| Latency | `stats.latencyP50Ms`, `latencyP95Ms` | p95 above 10 s |
| Dropped | `stats.chunksDropped` | Any increase |
| Last error | `sessions.lastError` | Shown until the next successful status |

## Demo helpers

- "Create demo sessions" button on an empty dashboard: seeds two `file_replay`
  sessions from `fixtures/audio` (one English, one Spanish) so a fresh install
  can show the whole flow within a minute.

## Verification

- Vitest: cookie signing and verification (valid, expired, tampered);
  `sessions.start` state transition and the outgoing request body against the
  `session-start.request.json` fixture (mocked fetch).
- Manual checklist for the dashboard, with the mock provider: create, start,
  observe `running` within 5 s, stop a pipeline process and observe `error`
  with `status_timeout` within 20 s, restart it and start the session again.
