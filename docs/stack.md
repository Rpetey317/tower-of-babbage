# Stack

## Web app (`apps/web`)

Scaffolded with `create-t3-app` (`--CI --appRouter --trpc --tailwind --drizzle --dbProvider postgres --biome`).

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 15, App Router, React 19 | Server Components by default |
| API | tRPC v11 | Queries and mutations over HTTP, subscriptions over SSE (`httpSubscriptionLink`) |
| Validation | Zod | tRPC inputs, internal events endpoint, env (`@t3-oss/env-nextjs`) |
| Database | Postgres 16 via Drizzle ORM (`postgres` driver) | Schema in `src/server/db/schema.ts`, `drizzle-kit push` for dev |
| Styling | Tailwind CSS v4 | Tokens from [branding.md](branding.md) declared in `globals.css` `@theme` |
| Fonts | `next/font` (self-hosted at build) | Barlow Condensed, Inter, Atkinson Hyperlegible |
| Auth | Env password + signed HttpOnly cookie | Custom, minimal; see [components/admin-panel.md](components/admin-panel.md) |
| i18n | Dictionary objects per locale, cookie/`?hl=` selected | No framework; see [components/languages.md](components/languages.md) |
| Lint/format | Biome | `pnpm lint`, `pnpm format` |
| Tests | Vitest | Pure functions (export, schemas, token) and route handlers |
| Package manager | pnpm 10, workspace at repo root | `pnpm-workspace.yaml` includes `apps/*` |

Directory sketch:

```
apps/web/src/
  app/                     routes (see components docs for the list)
  server/api/routers/      sessions, segments, admin
  server/db/               schema.ts, index.ts
  server/events/           bus.ts (in-memory), ingest-token.ts
  server/export/           srt.ts, vtt.ts, txt.ts
  lib/contract/            Zod schemas mirroring docs/contract.md
  lib/i18n/                dictionaries and helpers
  styles/globals.css       Tailwind theme tokens
```

## Pipeline (`services/pipeline`)

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | Go 1.24, module `github.com/Rpetey317/tower-of-babbage/services/pipeline` | |
| HTTP | `net/http` with `http.ServeMux` patterns | Control API, health |
| WebSocket | `github.com/coder/websocket` | Ingest endpoint |
| Audio decode | `ffmpeg` subprocess | File replay now, stream URL and devices later |
| VAD | Energy-based in Go (M1). Silero VAD via ONNX Runtime in the backlog | |
| Inference client | `net/http` against OpenAI-compatible chat completions | No SDK |
| Config | Environment variables, parsed once into a `Config` struct | |
| Logging | `log/slog`, JSON in production | |
| Lint | `go vet`, `staticcheck` | |
| Tests | `testing`, fixtures from `packages/contract/fixtures` and `fixtures/audio` | |

Package layout:

```
services/pipeline/
  cmd/pipeline/main.go     wiring and lifecycle
  internal/config/         env parsing
  internal/control/        HTTP control API and ingest WebSocket handler
  internal/ingest/         sources: websocket, filereplay (ffmpeg); PCM frame types
  internal/chunk/          chunker, energy VAD, audio clock
  internal/provider/       SpeechProvider interface, openaicompat, mock, gemini (stub)
  internal/session/        runner: queue, workers, backpressure, stats
  internal/emit/           batching client for the web events endpoint
  internal/contract/       structs mirroring docs/contract.md, fixture tests
```

## Inference sidecar

- Default: llama.cpp `llama-server` with `ggml-org/gemma-4-E2B-it-GGUF` and its
  audio-capable mmproj. Vulkan build for the AMD RX 6600; CUDA or Metal builds
  work unchanged.
- Alternative: vLLM with `google/gemma-4-E2B-it` or `E4B` on 24 GB+ NVIDIA GPUs.
- Both expose `POST /v1/chat/completions`; the audio content block differs
  (`input_audio` for llama.cpp, `audio_url` for vLLM), selected with
  `INFERENCE_AUDIO_FORMAT`.

## Infra and tooling

- `infra/compose.yml`: services `postgres`, `llama`, `llama-cpu`, `pipeline`,
  `web`. Profiles `infra` (postgres + Vulkan llama), `cpu` (CPU llama), and
  `all`. `make infra-up` selects CPU when `/dev/dri` is unavailable.
- `infra/pull-model.sh`: downloads the selected GGUF and BF16 mmproj into
  `infra/models/` (git-ignored), checking their Hugging Face SHA-256 values.
- Root `Makefile` targets: `infra-up`, `infra-down`, `model-pull`, `web`,
  `pipeline`, `db-push`, `test`, `lint`, `smoke`.
- `scripts/smoke.sh`: end-to-end check with the mock provider (see [testing.md](testing.md)).
- `scripts/transcribe-file.sh`: sends the first chunk of a WAV to the configured inference endpoint and prints the result; quickest way to check a model setup.
- `scripts/bench-latency.sh`: replays a fixture through N sessions and reports latency percentiles.

## Environment variables

Web (`apps/web/.env`):

| Variable | Example | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://babbage:babbage@localhost:5432/babbage` | Drizzle connection |
| `DATABASE_URL_TEST` | `postgres://babbage:babbage@localhost:5432/babbage_test` | Route-handler tests only |
| `ADMIN_PASSWORD` | `change-me` | Admin login |
| `AUTH_SECRET` | 32+ random bytes, base64 | Signs the admin cookie |
| `SHARED_SECRET` | 32+ random bytes, base64 | Bearer for control API calls and events endpoint, key for ingest tokens |
| `PIPELINE_URL` | `http://localhost:8090` | Control API base URL, server-side only |
| `NEXT_PUBLIC_PIPELINE_WS_URL` | `ws://localhost:8090` | Ingest WebSocket base URL used by the operator page |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | `es` | UI locale when none selected |

Pipeline (`services/pipeline/.env`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `LISTEN_ADDR` | `:8090` | Control API and ingest WebSocket |
| `WEB_URL` | `http://localhost:3000` | Events endpoint base URL |
| `SHARED_SECRET` | none, required | Must match the web app |
| `PROVIDER` | `openai-compat` | `openai-compat`, `mock`, `gemini` |
| `INFERENCE_URLS` | `http://localhost:8080` | Comma-separated OpenAI-compatible base URLs |
| `INFERENCE_MODEL` | `gemma-4` | `model` field sent in requests; llama-server ignores it, vLLM needs the HF id |
| `INFERENCE_AUDIO_FORMAT` | `input_audio` | `input_audio` (llama.cpp) or `audio_url` (vLLM) |
| `INFERENCE_MAX_CONCURRENCY` | `2` | In-flight requests per endpoint; match llama-server `--parallel` |
| `INFERENCE_TIMEOUT_SECONDS` | `20` | Per request |
| `INFERENCE_TEMPERATURE` | `0.2` | Sampling temperature; `top_p` 0.95 and `top_k` 64 are fixed |
| `MOCK_LATENCY_MS` | `300` | Simulated inference time for `PROVIDER=mock` |
| `GLOSSARY_ENFORCE` | `false` | Post-process transcripts with whole-word glossary replacement |
| `CHUNK_TARGET_SECONDS` | `6` | Preferred chunk length |
| `CHUNK_MAX_SECONDS` | `15` | Hard cut when no pause is found; never above 30 |
| `CHUNK_MIN_SECONDS` | `2` | Do not cut before this, even at a pause |
| `FIXTURES_DIR` | `../../fixtures/audio` | Root for `file_replay` paths; Dockerfile sets `/fixtures` in the container |
| `EVENTS_FLUSH_MS` | `250` | Batching window for the events endpoint |
| `LOG_LEVEL` | `info` | slog level |
| `GEMINI_API_KEY` | none | Only for `PROVIDER=gemini` (backlog) |

Compose-level (`infra/.env`, consumed by `infra/compose.yml` and mapped onto the variables above):

| Variable | Purpose |
| --- | --- |
| `POSTGRES_PASSWORD` | Database password; also embedded in `DATABASE_URL` for the `web` container |
| `POSTGRES_BIND_HOST` | Host address for the development database port (default `127.0.0.1`) |
| `LLAMA_BIND_HOST` | Host address for the inference port (default `127.0.0.1`) |
| `PUBLIC_WEB_URL` | Externally reachable web URL, used for links in exports and QR codes |
| `PUBLIC_PIPELINE_WS_URL` | Externally reachable ingest WebSocket URL; becomes `NEXT_PUBLIC_PIPELINE_WS_URL` |
| `SHARED_SECRET`, `AUTH_SECRET`, `ADMIN_PASSWORD` | Passed through to `web` and `pipeline` |

llama-server (`infra/compose.yml` `llama` service):

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLAMA_MODEL` | `ggml-org/gemma-4-E2B-it-GGUF` | HF repo passed to `-hf`; or a local GGUF path with `LLAMA_MMPROJ` |
| `LLAMA_CPU_MODEL` | `ggml-org/gemma-4-E2B-it-GGUF:Q4_0` | Smaller model used by the CPU fallback |
| `LLAMA_PARALLEL` | `4` | Concurrent slots |
| `LLAMA_CTX` | `16384` | Total context, shared across slots |
| `LLAMA_NGL` | `99` | Layers offloaded to GPU |
| `LLAMA_PORT` | `8080` | |

## Ports

| Service | Port |
| --- | --- |
| web | 3000 |
| pipeline | 8090 |
| llama-server | 8080 |
| postgres | 5432 |
