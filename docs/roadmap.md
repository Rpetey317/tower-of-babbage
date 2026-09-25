# Roadmap

Vibeathon deadline: **Friday 2026-09-25, around 12:00 (UTC-3)**. Milestones
M0-M6 are ordered by priority; the backlog waits until after the deadline.
How to pick up a task and open an issue: [AGENTS.md](../AGENTS.md) section 7.

Task line format: `ID · component · size · deps · status`, then goal, then
"Done when" (acceptance plus verification). Sizes: S under 1 h, M 1-3 h,
L 3-5 h of focused work. Status values: `todo`, `doing`, `done`. Update the
status here when you start and finish.

Three lanes can run in parallel from the start: **web** (`apps/web`),
**pipeline** (`services/pipeline`), **infra/contract/fixtures**. The demo and
MVP run inference on the Gemini API (ADR-011); the local Gemma 4 path
(M0-08, M1-10) is no longer on the critical path. The critical path to the
first end-to-end demo is
M0-01 -> M0-03 -> M1-07 -> M1-11 -> M1-12 -> M1-13 plus M1-16 -> M1-14 for
real Gemini inference on the pipeline side and
M0-02 -> M1-01 -> M1-02 -> M1-03 -> M1-04 on the web side.

## M0: Scaffold

- **M0-01** · infra · S · deps none · `done`
  Repository skeleton: `pnpm-workspace.yaml`, root `package.json`, `Makefile` with the targets from [stack.md](stack.md), `.gitignore`, `.editorconfig`, `infra/compose.yml` with profile `infra` (postgres, llama Vulkan), `infra/.env.example`.
  Done when: `make infra-up` starts Postgres and llama-server (model download may still be running), `make infra-down` stops them, `make help` lists targets.
- **M0-02** · web · M · deps M0-01 · `done`
  Scaffold T3 in `apps/web` (`--CI --appRouter --trpc --tailwind --drizzle --dbProvider postgres --biome`), env schema for every web variable, `/api/health`, Tailwind theme tokens and fonts from [branding.md](branding.md), empty layout with header and locale toggle.
  Done when: `pnpm dev` serves `/` and `/api/health` returns `{"status":"ok"}` against the compose database; `pnpm lint` and `pnpm typecheck` pass.
- **M0-03** · pipeline · S · deps M0-01 · `done`
  Go module skeleton: `cmd/pipeline`, `internal/config` (all variables from stack.md with defaults and validation), `internal/control` with `GET /healthz`, slog JSON logging, graceful shutdown, `Dockerfile` with ffmpeg.
  Done when: `make pipeline` answers `/healthz` with the contract payload (`provider: mock` when configured); `go vet` and `staticcheck` clean; image builds.
- **M0-04** · contract · S · deps none · `done`
  Fixture files listed in [contract.md](contract.md) section 7 under `packages/contract/fixtures/`, plus `packages/contract/README.md` pointing at the doc, plus `packages/contract/tools/make-token-vector.mjs` that generates `ingest-token.vector.json`.
  Done when: every fixture validates against the shapes in the contract by inspection; the vector file contains `secret`, `payload`, `expectedToken`.
- **M0-05** · web · S · deps M0-02, M0-04 · `done`
  Zod schemas in `src/lib/contract/` for every contract message, `contractVersion` constant, fixture round-trip test, ingest token mint and verify functions with the vector test.
  Done when: `pnpm test` passes the fixture and vector tests.
- **M0-06** · pipeline · S · deps M0-03, M0-04 · `done`
  Go structs in `internal/contract/` for every message, fixture round-trip test, token verification with the vector test.
  Done when: `go test ./internal/contract/...` passes.
- **M0-07** · fixtures · S · deps none · `done`
  `fixtures/audio/`: `en-kubernetes-60s`, `es-charla-60s` (wav 16 kHz mono, `.txt` ground truth, `.mock.txt` lines), `LICENSES.md`. Recorded or synthesized per [testing.md](testing.md).
  Done when: `ffprobe` reports 16 kHz mono s16 for each file; durations within 5 s of the nominal; licenses documented.
- **M0-08** · infra · M · deps M0-01 · `doing`
  Local path only; not required for the Gemini demo.
  `infra/pull-model.sh`, `scripts/transcribe-file.sh`, and a first run of Gemma 4 E2B on the demo box (Vulkan). Record in the issue: `vulkaninfo --summary` VRAM, chosen quant, raw model output for the fixture, time per request.
  Done when: `scripts/transcribe-file.sh fixtures/audio/en-kubernetes-60s.wav` prints an English transcript and a Spanish translation from the real model.
- **M0-09** · infra · M · deps M0-08 · `doing`
  Native Windows inference path (issue #47): `dev.ps1` task runner (`model-pull`, `inference`, `transcribe`, `test-inference`), `infra/pull-model.ps1` (SHA-256-checked GGUF + BF16 mmproj download), `infra/start-inference.ps1` (foreground Vulkan launcher), `infra/env.ps1` dotenv sourcing (`infra/.env` over `infra/.env.example`, process env wins), `scripts/transcribe-file.ps1` (first-10-s fixture AST check), `scripts/windows-inference.test.ps1` offline stub tests, and deployment docs for the RX 6600 Vulkan path on Windows.
  Done when: `powershell -NoProfile -File dev.ps1 test-inference` passes on Windows PowerShell 5.1+ and `dev.ps1 transcribe` prints an English transcript and a Spanish translation on the demo box. The real-GPU acceptance run was deferred by the user (scripts and instructions only); hardware evidence is still pending and should be recorded in issue #47.

## M1: Vertical slice (one session, end to end)

- **M1-01** · web · M · deps M0-02 · `done`
  Drizzle schema from [domain-model.md](domain-model.md) (`sessions`, `segments`, `glossary_terms`, `session_events`, enums, indexes), `make db-push`, `pnpm db:seed` creating two `file_replay` demo sessions (`demo-en`, `demo-es`).
  Done when: push succeeds on a clean database; seed is idempotent; `drizzle-kit check` clean.
- **M1-02** · web · M · deps M1-01, M0-05 · `done`
  `POST /api/internal/events` per [realtime.md](components/realtime.md): bearer check, Zod, atomic transaction, segment upsert, status application, log insert, bus publish; watchdog for `status_timeout`.
  Done when: route tests cover valid batch, bad bearer, malformed event, duplicate segment (single row), watchdog flips a stale session to `error`.
- **M1-03** · web · M · deps M1-02 · `done`
  `server/events/bus.ts`, routers `sessions` (`list`, `bySlug`) and `segments` (`recent`, `onSegment` SSE with `tracked` ids and catch-up).
  Done when: unit tests for id encoding and catch-up; `curl -N` on the subscription prints events published through the events endpoint.
- **M1-04** · web · L · deps M1-03 · `done`
  Audience pages per [audience-web.md](components/audience-web.md): `/` session list with room colors, `/s/[slug]` caption view with language and mode switches, font size control, connection pill, chunk-merging reducer, minimal `es`/`en` dictionaries.
  Done when: reducer tests pass; manual check with the mock provider on phone and desktop; Lighthouse accessibility score at least 95 on `/s/demo-en`.
- **M1-05** · web · L · deps M1-01, M0-05 · `done`
  Admin foundation per [admin-panel.md](components/admin-panel.md): login with cookie, middleware, `protectedProcedure`, `admin.sessions.*` CRUD, `start` and `stop` calling the control API, `ingestToken`, minimal `/admin` list with start/stop buttons, `/admin/sessions/new` and `/admin/sessions/[id]` forms.
  Done when: cookie tests pass; `start` request body matches `session-start.request.json` (mocked fetch); manual: create, start, stop against the running pipeline.
- **M1-06** · web · M · deps M1-05 · `done`
  Operator page `/admin/sessions/[id]/operator`: `getUserMedia`, 16 kHz `AudioContext`, worklet to Int16 200 ms frames, WebSocket per contract section 4, level meter, reconnect with fresh token.
  Done when: manual: `audioReceivedMs` grows at wall-clock rate for 2 minutes in Chromium and Firefox; reconnect after killing the pipeline works.
- **M1-07** · pipeline · M · deps M0-03 · `done`
  `internal/chunk`: PCM frame type, audio clock, WAV encoder, energy VAD with adaptive noise floor, chunker cut rules from [ingest.md](components/ingest.md).
  Done when: synthetic-signal tests (cuts inside silences, hard cut at max, silent chunks discarded) pass; replay of `en-kubernetes-60s.wav` yields the golden chunk count.
- **M1-08** · pipeline · M · deps M0-06, M1-07 · `done`
  `internal/ingest`: WebSocket handler (hello, ready, binary frames, stats, end, close codes, producer replacement) with token verification; `file_replay` source spawning ffmpeg with path validation.
  Done when: handler tests with a WebSocket client cover the protocol and close codes; replay test streams the fixture and reports its length within one frame.
- **M1-09** · pipeline · M · deps M0-03 · `done`
  `internal/provider`: `SpeechProvider` interface, `prompts.go` (ASR, AST, translate, glossary block, language names), AST output parser, `mock` provider with `.mock.txt` support.
  Done when: table-driven tests for prompts and parser (well-formed, missing marker, multi-line, 60-term glossary cap); mock returns deterministic output.
- **M1-10** · pipeline · M · deps M1-09 · `done`
  Local path only; not required for the Gemini demo.
  `openaicompat` provider: request building for `input_audio` and `audio_url`, `chat_template_kwargs.enable_thinking=false`, endpoints with round-robin and per-endpoint semaphore, health marking and probing, single retry policy.
  Done when: `httptest` tests assert request bodies for both formats, retry on 5xx, unhealthy marking after 3 failures, recovery after probe.
- **M1-11** · pipeline · L · deps M1-07, M1-08, M1-09, M0-06 · `done`
  `internal/session` runner: start/stop lifecycle with `runId`, chunk queue with backpressure, provider workers honoring `translationMode` and the AST fallback, latency accounting, stats and 5 s status heartbeat; `internal/emit` batching client with retry and bounded buffer.
  Done when: runner test with the mock provider and a synthetic source emits segments in order with correct `startMs`/`endMs`, drops under a full queue with `chunk_dropped`, sends `status` at least every 5 s; emitter test retries and caps the buffer.
- **M1-12** · pipeline · S · deps M1-11 · `done`
  Control API `start`, `stop`, `GET /v1/sessions` wired to the runner, validation errors `unsupported_language` and `invalid_source`, `409 already_running`.
  Done when: handler tests cover the responses in contract section 2.
- **M1-13** · infra · M · deps M1-03, M1-05, M1-12 · `done`
  `scripts/smoke.mjs` and `scripts/smoke.sh` per [testing.md](testing.md) (steps 1-4 and 6; step 5 arrives with M3-02); `make smoke`.
  Done when: `make smoke` is green on a laptop with the mock provider in under 60 s.
- **M1-14** · infra · M · deps M1-13, M1-16 · `done`
  First real run: pipeline on the laptop with `PROVIDER=gemini` and
  `GEMINI_API_KEY`, `demo-en` session. Record WER (`scripts/wer.mjs`),
  p50/p95 latency and any parsing failures in the issue; tune `CHUNK_*`,
  `GEMINI_MODEL` and temperature defaults if needed and update stack.md.
  Done when: a 60 s replay produces Spanish captions end to end with p95 latency under 10 s, results recorded.
- **M1-15** · docs · S · deps M1-13 · `todo`
  README quick start verified from a clean clone; add two screenshots (audience, admin).
  Done when: a second person or agent follows README only and reaches captions with the mock provider.
- **M1-16** · pipeline · M · deps M1-09 · `doing`
  `gemini` provider per [speech-engine.md](components/speech-engine.md): `generateContent` REST client with `inlineData` WAV, `GEMINI_API_KEY`/`GEMINI_MODEL` config, concurrency bound from `INFERENCE_MAX_CONCURRENCY`, error mapping, single retry on transient failures; Gemini variant of `scripts/transcribe-file.sh`.
  Done when: `httptest` tests assert request shape, auth header and error handling; a real API call against `en-kubernetes-60s.wav` prints transcript and translation, recorded in the issue.

## M2: Many sessions and monitoring

- **M2-01** · pipeline · M · deps M1-11 · `done`
  Concurrent runners sharing provider capacity: per-session isolation, fair scheduling across sessions (round-robin over session queues), clean shutdown of many sessions.
  Done when: test with 4 mock sessions shows all progressing, no goroutine leaks (`goleak`), stats independent per session.
- **M2-02** · web · L · deps M1-05, M1-03 · `done`
  Monitoring dashboard at `/admin` per [admin-panel.md](components/admin-panel.md): columns and alarms, `admin.onStatus` live updates, `pipelineHealth`, `session_events` log on the session page.
  Done when: manual checklist in admin-panel.md passes with the mock provider, including `status_timeout` after killing the pipeline.
- **M2-03** · web · M · deps M1-05 · `done`
  Complete session form: room color picker from the token set, source type with per-type config fields, translation mode, ordered target languages; "Create demo sessions" button on an empty dashboard.
  Done when: creating each source type persists the right `sourceConfig`; demo button seeds `demo-en` and `demo-es`.
- **M2-04** · infra · M · deps M2-01, M1-14 · `todo`
  `scripts/bench-latency.sh`; run on the demo machine with the Gemini provider with 1, 2 and 4 replay sessions; fill the capacity table in [deployment.md](deployment.md).
  Done when: the table has measured numbers and the script is reproducible.
- **M2-05** · infra · M · deps M1-13 · `todo`
  Compose profile `all`: `apps/web/Dockerfile` (standalone), `services/pipeline/Dockerfile`, health checks, migrations at web start, documented `PUBLIC_*` variables.
  Done when: `docker compose -f infra/compose.yml --profile all up` on a clean machine serves the audience page and `make smoke` passes against it.

## M3: Export

- **M3-01** · web · M · deps M1-01 · `done`
  `server/export/` SRT, VTT and TXT generators with the cue rules from [export.md](components/export.md).
  Done when: golden-file tests pass including split, merge and empty-run cases.
- **M3-02** · web · S · deps M3-01, M1-05 · `done`
  `GET /api/export/[sessionId]` route, download buttons per language on the session page, smoke step 5.
  Done when: route test checks headers and body; `make smoke` verifies at least 3 cues.

## M4: Glossary

- **M4-01** · web · M · deps M1-05 · `done`
  `glossary_terms` CRUD for global and session scope, bulk paste (`term = translation`), merge/dedupe/cap into the start request, session page editor and `/admin/glossary`.
  Done when: merge logic tests pass; start request contains the merged list.
- **M4-02** · pipeline · S · deps M1-12 · `done`
  `PUT /v1/sessions/{id}/glossary` replacing the active glossary for later chunks; optional `GLOSSARY_ENFORCE` post-replacement.
  Done when: handler test; runner test shows the next prompt uses the new list; replacement test for whole-word behaviour.
- **M4-03** · infra · S · deps M4-01, M1-14 · `todo`
  Quality check: replay the English fixture with and without a glossary containing `kubectl`, `etcd`, `Nerdearla`; record spellings and WER in the issue; decide whether `GLOSSARY_ENFORCE` should default on.
  Done when: results recorded in the issue and summarized in [glossary.md](components/glossary.md).

## M5: OBS overlay

- **M5-01** · web · M · deps M1-03 · `done`
  `/overlay/[slug]` per [obs-overlay.md](components/obs-overlay.md): transparent background, parameters, outline text, silent reconnect, empty when not live.
  Done when: manual check over a checkered background and in OBS Browser Source during a mock run; at most `lines` lines visible.
- **M5-02** · docs · S · deps M5-01 · `done`
  Operator instructions for OBS and vMix verified with screenshots in the doc.
  Done when: a person unfamiliar with the project adds the overlay following the doc.

## M6: Languages

- **M6-01** · web, pipeline · M · deps M1-12, M2-03 · `done`
  `SUPPORTED_LANGUAGES` in the web app with "verified" flags, admin multi-select, Go language table, `unsupported_language` validation.
  Done when: creating `pt -> es` works; an unknown code is rejected at start with 400.
- **M6-02** · web · M · deps M1-04 · `done`
  Full `es`/`en` interface coverage for audience, overlay and admin; locale resolution order; parity test.
  Done when: parity test passes; `?hl=en` and the toggle switch every visible string.
- **M6-03** · fixtures · S · deps M6-01, M0-07 · `todo`
  `pt-sample-30s` fixture with ground truth; quality check `pt -> es` recorded in the issue and in [languages.md](components/languages.md).
  Done when: captions are Portuguese and Spanish respectively; WER recorded.

## Backlog (after the Vibeathon)

Ingest
- `stream_url` source (RTMP, HLS, SRT, YouTube via ffmpeg) and `device` source (PulseAudio/PipeWire/ALSA).
- Silero VAD through ONNX Runtime; chunk overlap with duplicate-word removal; gain normalization.
- Partial (non-final) segments from a rolling window for lower perceived latency.

Providers
- Gemini Live API provider for streaming transcription, bypassing the chunker.
- Per-session provider selection; Whisper-family provider for ASR-only setups.
- Context carry-over of the previous transcript into prompts, with repetition guard.

Delivery and web
- Redis bus for multiple web instances; Prometheus metrics endpoint on the pipeline.
- Better Auth with accounts and roles; per-session operator tokens with longer TTL.
- QR code and short link per session; light theme; PWA install; Playwright suite.
- Event entity (one deployment serving several conferences), schedule import.

Integrations and export
- obs-websocket `SendStreamCaption`; NDI or SDI caption inserters via partners.
- Batch export of all sessions as a zip; DOCX/Markdown transcripts with speaker labels.

Platform
- Contract code generation from JSON Schema for TypeScript and Go.
- Generated Drizzle migrations instead of `push`; GitHub Actions running `make lint test smoke`.
- Documentation site built from `docs/`.
