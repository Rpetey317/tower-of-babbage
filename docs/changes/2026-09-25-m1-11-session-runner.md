# M1-11: session runner and event emitter

- `internal/session`: `Registry` (implements `ingest.Sessions`, `Sessions()`
  for `/v1/sessions`, `Active()` for `/healthz`) and `Runner` (implements
  `ingest.Sink`). Frames feed the chunker; chunks go through a bounded queue
  (cap 4, drop oldest with `chunk_dropped` on overflow). Provider calls are
  bounded by `INFERENCE_MAX_CONCURRENCY`; results emit strictly in chunk
  order via an outstanding-index tracker — dropped chunks cannot wedge it.
  `ast` mode uses `TranscribeAndTranslate` and falls back to
  Transcribe+Translate on `ok=false` or `ErrBadOutput` (`provider_bad_output`).
  Latency is `emittedAt - (runStartWall + endMs)`; p50/p95 over the last 256
  chunks. Status heartbeat every 5 s; `no_audio` warn after 10 s without
  frames; `Stop` flushes the chunker tail, drains the queue and ends `idle`.
  `ffmpeg_exit` from the replay source puts the run in `error`.
- `internal/emit`: batching client for `POST /api/internal/events`. Flushes
  every `EVENTS_FLUSH_MS` or at 50 events, exponential backoff capped at
  30 s, per-session buffers capped at 5000 events dropping the oldest with
  `events_dropped`. Implements `ingest.Events`.
- `cmd/pipeline`: wired provider (mock / openai-compat; gemini fails fast
  until M1-16), emit client and registry into the ingest handler. Control
  start/stop routes arrive with M1-12.

Verification: `go test ./...` and `go test -race ./internal/session
./internal/emit` all green; `go vet ./...` clean. staticcheck 2025.1 cannot
parse this toolchain's export data (skipped). Runner tests cover ordered
segments with timestamps, `chunk_dropped` under a full queue, heartbeat,
AST fallback, and stop-flush; emitter tests cover retry, batch split at 50,
buffer cap and `emittedAt` format.
