# Contract: web <-> pipeline <-> browser

Source of truth for every message that crosses a process boundary. Fixtures
live in `packages/contract/fixtures/`; the Go structs (`services/pipeline/internal/contract`)
and the Zod schemas (`apps/web/src/lib/contract`) must parse all of them. See
[AGENTS.md](../AGENTS.md) section 5 for the change procedure.

`contractVersion`: **2**. Sent in every start request and events batch; a
mismatch is rejected with `400 contract_version_mismatch`. Version 2 adds the
optional `speaker` field on `segment` events (section 3).

Conventions: JSON, camelCase, UTC ISO 8601 timestamps with milliseconds
(`2026-09-25T14:03:12.345Z`), uuids as lowercase strings, durations in integer
milliseconds, languages as lowercase BCP 47 primary tags.

## 1. Authentication

| Path | Mechanism |
| --- | --- |
| Web -> pipeline control API | `Authorization: Bearer <SHARED_SECRET>` |
| Pipeline -> web events endpoint | `Authorization: Bearer <SHARED_SECRET>` |
| Browser -> pipeline ingest WebSocket | `?token=<ingest token>` minted by the web app (section 5) |

Missing or wrong credentials: `401 {"error":"unauthorized"}`.

## 2. Control API (web -> pipeline)

Base URL: `PIPELINE_URL`.

### `GET /healthz`

No auth. Used by compose health checks and the admin dashboard.

```json
{
  "status": "ok",
  "contractVersion": 2,
  "provider": "openai-compat",
  "endpoints": [{ "url": "http://localhost:8080", "healthy": true }],
  "activeSessions": 2
}
```

### `GET /v1/sessions`

Running sessions with their latest stats (same `stats` object as the status event).

```json
{ "sessions": [{ "sessionId": "…", "runId": "…", "status": "running", "stats": { "…": "…" } }] }
```

### `POST /v1/sessions/{sessionId}/start`

```json
{
  "contractVersion": 2,
  "runId": "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77",
  "slug": "gran-sala",
  "sourceLanguage": "en",
  "targetLanguages": ["es"],
  "translationMode": "ast",
  "source": { "type": "browser_mic", "config": {} },
  "glossary": [
    { "term": "Kubernetes", "translation": null },
    { "term": "pull request", "translation": "pull request" }
  ]
}
```

- `source.type`: `browser_mic` (audio arrives over the ingest WebSocket),
  `file_replay` (`config.path` relative to the pipeline's `FIXTURES_DIR`, `config.loop` bool),
  `stream_url` and `device` (backlog, see [components/ingest.md](components/ingest.md)).
- `translationMode`: `ast` or `asr_then_text`, see [components/speech-engine.md](components/speech-engine.md).
- `glossary`: may be empty. `translation: null` means keep the term as is.

Responses: `202 {"runId":"…","status":"starting"}`. Idempotent for the same
`runId`. `409 {"error":"already_running","runId":"<current>"}` if a different run
is active; the web app must stop it first. `400 {"error":"unsupported_language"}`
or `400 {"error":"invalid_source"}` for bad configuration.

### `POST /v1/sessions/{sessionId}/stop`

Body optional `{"runId":"…"}`. `202 {"runId":"…","status":"stopping"}`; the
pipeline flushes the pending chunk, emits its final segments, then a `status`
event with `idle`. `404 {"error":"not_running"}` if nothing is active.

### `PUT /v1/sessions/{sessionId}/glossary` (M4)

Body `{"glossary":[…]}` with the same item shape as in start. Replaces the
active glossary for the running session. `200 {"count": n}`.

## 3. Events API (pipeline -> web)

`POST {WEB_URL}/api/internal/events`. Batches are flushed every `EVENTS_FLUSH_MS`
or when 50 events accumulate. The pipeline retries failed batches with
exponential backoff (max 30 s) and keeps at most 5000 events in memory per
session, dropping the oldest and logging `events_dropped`.

```json
{
  "contractVersion": 2,
  "events": [
    {
      "type": "segment",
      "sessionId": "…",
      "runId": "…",
      "chunkIndex": 12,
      "kind": "original",
      "language": "en",
      "text": "So the scheduler places the pod on a node with enough memory.",
      "speaker": "S1",
      "isFinal": true,
      "startMs": 72000,
      "endMs": 78400,
      "emittedAt": "2026-09-25T14:03:12.345Z",
      "latencyMs": 2140
    },
    {
      "type": "segment",
      "sessionId": "…",
      "runId": "…",
      "chunkIndex": 12,
      "kind": "translation",
      "language": "es",
      "text": "Entonces el scheduler ubica el pod en un nodo con suficiente memoria.",
      "speaker": "S1",
      "isFinal": true,
      "startMs": 72000,
      "endMs": 78400,
      "emittedAt": "2026-09-25T14:03:12.345Z",
      "latencyMs": 2140
    },
    {
      "type": "status",
      "sessionId": "…",
      "runId": "…",
      "status": "running",
      "stats": {
        "audioReceivedMs": 78400,
        "chunksProcessed": 13,
        "chunksDropped": 0,
        "queueDepth": 1,
        "latencyP50Ms": 2100,
        "latencyP95Ms": 3900,
        "lastError": null
      },
      "emittedAt": "2026-09-25T14:03:12.400Z"
    },
    {
      "type": "log",
      "sessionId": "…",
      "runId": "…",
      "level": "warn",
      "code": "chunk_dropped",
      "message": "queue full, dropped chunk 14",
      "data": { "chunkIndex": 14 },
      "emittedAt": "2026-09-25T14:03:20.000Z"
    }
  ]
}
```

`segment` fields:

- `speaker` (optional, v2): speaker label attributed by the provider for the
  chunk (`S1`, `S2`, …, numbered in first-appearance order). The same label is
  set on the chunk's `original` and `translation` segments. Absent when the
  provider cannot attribute the chunk; labels are only stable within a chunk,
  not across the run. Segments without `speaker` render as before.

Event types:

| Type | Web app behaviour |
| --- | --- |
| `segment` | Upsert on `(sessionId, runId, chunkIndex, language)`, then publish on the bus for SSE |
| `status` | Update `sessions.status`, `lastError`, `currentRunId`; keep `stats` in memory for the admin panel. `status` values: `starting`, `running`, `stopping`, `idle`, `error` |
| `log` | Insert into `session_events`; `level: error` also sets `sessions.lastError` |

Heartbeat: while a run is active the pipeline emits a `status` event at least
every 5 s. The web app marks a session `error` with code `status_timeout` after
15 s of silence.

Response: `200 {"accepted": 4}`. Invalid body: `400 {"error":"invalid_events","details":[…]}`.
A batch is atomic: either all events are accepted or none.

## 4. Ingest WebSocket (browser -> pipeline)

`GET {NEXT_PUBLIC_PIPELINE_WS_URL}/v1/sessions/{sessionId}/ingest?token=<token>`

1. Client sends one text frame: `{"type":"hello","format":"pcm_s16le","sampleRate":16000,"channels":1}`.
   Only this format is accepted in version 1. Missing hello within 5 s: close `4000`.
2. Server answers `{"type":"ready","sessionId":"…","runId":"…"}`.
3. Client sends binary frames: raw little-endian signed 16-bit PCM, mono,
   16 kHz. Recommended frame length 100-250 ms (3200-8000 bytes).
4. Server sends every 2 s: `{"type":"stats","audioReceivedMs":12345,"queueDepth":0}`.
5. Client may send `{"type":"end"}` before closing so the pipeline flushes the
   partial chunk immediately instead of waiting for silence.

Close codes: `4000` protocol error, `4001` invalid or expired token, `4004`
session not running, `4009` replaced by a newer producer, `1011` internal error.
One producer per run: a new connection takes over and the previous one is
closed with `4009`.

The audio clock advances by received samples only. Gaps in delivery do not
create silence; the operator page must send continuously.

## 5. Ingest token

Minted by the web app for admins (`admin.ingestToken` mutation), verified by
the pipeline with the shared secret.

```
payload = base64url(JSON {"sessionId":"…","exp":1758810000})   // exp: unix seconds, TTL 10 minutes
token   = payload + "." + base64url(HMAC-SHA256(key = SHARED_SECRET, message = payload))
```

Verification: constant-time signature compare, `exp` in the future,
`sessionId` equal to the path parameter. The fixture
`ingest-token.vector.json` holds `secret` (base64-encoded `SHARED_SECRET`),
`payload` (the base64url string above), and `expectedToken`. Decode the secret
to bytes before using it as the HMAC key. Both implementations must reproduce
`expectedToken` exactly.

## 6. Error and log codes

| Code | Level | Emitted by | Meaning |
| --- | --- | --- | --- |
| `provider_unavailable` | error | pipeline | All inference endpoints failing |
| `provider_timeout` | warn | pipeline | One request exceeded `INFERENCE_TIMEOUT_SECONDS` |
| `provider_bad_output` | warn | pipeline | Model output could not be parsed (AST format); chunk emitted as original only or skipped |
| `chunk_dropped` | warn | pipeline | Backpressure dropped a chunk |
| `events_dropped` | error | pipeline | Event buffer overflow while the web app was unreachable |
| `no_audio` | warn | pipeline | No frames for 10 s on a running session |
| `ingest_replaced` | info | pipeline | A new producer connected |
| `ffmpeg_exit` | error | pipeline | Replay or stream decoder exited unexpectedly |
| `status_timeout` | error | web | No status event for 15 s |
| `contract_version_mismatch` | error | both | Version field differs |
| `unsupported_language`, `invalid_source` | error | pipeline | Start request rejected (HTTP 400, not a log event) |

## 7. Fixtures

`packages/contract/fixtures/`

| File | Covers |
| --- | --- |
| `healthz.response.json` | Section 2 |
| `sessions.response.json` | Section 2 |
| `session-start.request.json`, `session-start.response.json` | Section 2 |
| `events.batch.json` | Section 3, one of each event type |
| `ingest.hello.json`, `ingest.ready.json`, `ingest.stats.json` | Section 4 |
| `ingest-token.vector.json` | Section 5 |

Tests: `services/pipeline/internal/contract/fixtures_test.go` and
`apps/web/src/lib/contract/fixtures.test.ts` load every file and assert a
round trip (parse, re-serialize, deep-equal).

## 8. Web HTTP surface (reference)

Not part of the cross-service contract, listed so route names stay consistent.

| Route | Purpose | Doc |
| --- | --- | --- |
| `/api/trpc/[trpc]` | tRPC routers `sessions`, `segments`, `admin` | [components/realtime.md](components/realtime.md), [components/admin-panel.md](components/admin-panel.md) |
| `/api/internal/events` | Section 3 | |
| `/api/health` | `200 {"status":"ok"}` when the database answers; used by compose | [deployment.md](deployment.md) |
| `/api/export/[sessionId]` | `?format=srt|vtt|txt&lang=es&run=<runId>` | [components/export.md](components/export.md) |
| `/`, `/s/[slug]` | Audience | [components/audience-web.md](components/audience-web.md) |
| `/overlay/[slug]` | OBS overlay | [components/obs-overlay.md](components/obs-overlay.md) |
| `/admin/**` | Admin | [components/admin-panel.md](components/admin-panel.md) |
