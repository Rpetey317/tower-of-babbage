# Monitoring dashboard (M2-02)

Built the live monitoring view per `docs/components/admin-panel.md`.

- `admin` router (`apps/web/src/server/api/routers/admin.ts`): new
  `events.recent` (last N `session_events` for a session, newest first),
  `pipelineHealth` (proxies `GET /healthz`, returns `{ ok: false, error }`
  instead of throwing so polling renders an unreachable state), and
  `onStatus` (SSE subscription over the `status:*` bus topic: `status` +
  `log` events + watchdog `status_timeout`, 15 s keepalive, tracked ids,
  no `lastEventId` replay — the client reconciles via `sessions.list`).
- `lib/admin/monitoring.ts`: alarm predicates per the monitoring semantics
  table — audio drift > 10 s vs wall clock since `startedAt`
  (`audioStalled`), `queueDepth > 2` (`queueSaturated`, single sample: each
  heartbeat already spans seconds), `latencyP95Ms > 10 s` (`latencyHigh`),
  `chunksDropped > 0` (`hasDroppedChunks`) — plus `formatAudioMs` /
  `formatLatencyMs`.
- `/admin` (`admin/page.tsx` + `_components/monitoring-dashboard.tsx`):
  server-rendered rows hydrated into `admin.sessions.list` (`initialData`,
  10 s refetch reconciles creates/edits/deletes missed by the event stream).
  `admin.onStatus` overlays live `status`/`stats`/`lastError` per row, with
  an `emittedAt > updatedAt` freshness check so a stale refetch cannot
  regress a just-applied event. Alarms colour cells (coral/orange) with a
  tooltip; a 1 s ticker keeps the drift alarm moving between heartbeats.
  `ConnectionPill` shows the SSE state.
- `_components/pipeline-health.tsx`: provider, per-endpoint health dots and
  `activeSessions`, coral "unreachable" state on `ok: false`.
- `/admin/sessions/[id]`: `SessionEventsLog` renders the last 100
  `session_events` (SSR `initialData`, 15 s refetch) and prepends live `log`
  events for the session from `onStatus`, deduped by content key.
- i18n: `admin*` keys for the new columns, the pipeline card, the events
  log and the alarm tooltips (`en` + `es`); new exported `Dictionary` type
  for `copy` props.

Verification:

- `pnpm test` (against `babbage_test_m202`): 108 tests, including
  `events.recent` order/limit/NOT_FOUND, `pipelineHealth` ok/unreachable/
  invalid (stubbed `fetch`), `onStatus` forwarding `status` + `log` from the
  bus, and the monitoring predicates.
- Manual checklist with `PROVIDER=mock` (web :3100, pipeline :8190):
  create → start → `running` within 5 s with live stats on SSE; kill the
  pipeline → `error` + `status_timeout` within 20 s, `session_events` row
  written, watchdog event streamed to `onStatus`; restart → start again →
  `running`; stop → `idle`. `pipelineHealth` reported `ok: true` (provider
  `mock`) while up and `ok: false` while down.
