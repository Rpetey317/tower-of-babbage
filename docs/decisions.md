# Decisions

Architecture decision records, newest last. Format: context, decision,
consequences. Append; do not rewrite history. Superseded entries get a note.

## ADR-001: T3 web app plus a Go pipeline service

Context. The web side (audience, admin, API, persistence) fits T3 well. The
audio side is long-running goroutine-style work: WebSocket ingest, ffmpeg
subprocesses, chunking, concurrent model calls, backpressure. Next.js is a poor
host for that. The owner prefers Go after TypeScript.

Decision. Monorepo with `apps/web` (T3) and `services/pipeline` (Go). They
communicate only through the HTTP/WebSocket contract in
[contract.md](contract.md). Shared types are hand-written on both sides and
checked against shared JSON fixtures.

Consequences. Two languages and two test suites. Contract changes need
coordination (AGENTS.md section 5). In exchange, each side is idiomatic and can
be developed and scaled independently. Code generation from a schema is a
backlog item if drift becomes a problem.

## ADR-002: Gemma 4 through an OpenAI-compatible sidecar

Context. The brief recommends Gemini audio or Gemma for local. Research on
2026-09-24: Gemma 4 E2B/E4B/12B have native audio input (ASR and speech
translation, 30 s max per request); llama.cpp `llama-server` serves them with
`input_audio` content blocks, vLLM with `audio_url`; Ollama does not support
audio input. The demo GPU is an AMD RX 6600, so llama.cpp with Vulkan is the
only practical local runtime.

Decision. Default provider speaks OpenAI-compatible chat completions to a
sidecar (llama-server by default, vLLM as an alternative), selected by URL and
audio block format. No Python in the repository. Gemini is a second provider
behind the same interface.

Consequences. Model serving is an infrastructure concern with well-known
tooling; swapping models or hardware does not touch application code. Real-time
streaming ASR is not available, so the pipeline chunks audio.

Superseded in part by ADR-011: the demo and MVP run on the Gemini API instead
of the local sidecar. The OpenAI-compatible path remains for self-hosted
deployments.

## ADR-003: One audio call per chunk with the AST prompt

Context. Google publishes an AST prompt for Gemma 4 whose output contains the
transcript followed by `{Target}: translation`. The alternative, ASR then a
text translation call, costs two model calls but handles several target
languages more naturally.

Decision. `translationMode: ast` is the default: one audio call per chunk for
the first target language, text calls for additional targets. `asr_then_text`
remains available per session. Unparseable AST output falls back to a text
translation call for that chunk.

Consequences. Lowest latency and encoder cost for the common single-target
case. Output parsing is a failure point, mitigated by tests over sample outputs
and the fallback.

## ADR-004: The web app is the only database writer

Context. Two services could both write to Postgres, or one could own it.

Decision. Only the web app touches Postgres. The pipeline pushes events to
`/api/internal/events`; the web app persists and fans out.

Consequences. One schema owner, one migration path, the pipeline stays
stateless and easy to restart. Cost: the pipeline must buffer and retry events
when the web app is down (bounded buffer, documented in the contract).

## ADR-005: Server-Sent Events through tRPC subscriptions for delivery

Context. Browsers need a one-directional stream of segments. Options:
WebSockets (needs a custom server with Next.js), SSE (works in route handlers),
polling.

Decision. tRPC v11 subscriptions over `httpSubscriptionLink` (SSE) with
`tracked` ids for reconnection. In-process `EventEmitter` bus on `globalThis`.

Consequences. Works with a plain Next.js deployment and reverse proxies. Single
web instance for now; Redis pub/sub swap is confined to `server/events/bus.ts`.

## ADR-006: Browser mic audio goes straight to the pipeline

Context. Mic audio could be relayed through the web app or sent to the pipeline.

Decision. The operator page opens a WebSocket directly to the pipeline with a
short-lived HMAC token minted by the web app.

Consequences. Next.js stays out of the binary streaming path. The pipeline
must be reachable from operator laptops (documented in deployment), and the
token scheme is part of the contract with a cross-language test vector.

## ADR-007: Postgres with Drizzle

Context. SQLite would be simpler for a single-machine install, but the T3
default tooling, multi-connection access from route handlers and tests, and
future multi-instance web deployments favor Postgres. Docker is already
required for llama-server.

Decision. Postgres 16 in compose, Drizzle ORM with `drizzle-kit push` during
the hackathon and generated migrations afterwards.

Consequences. One more container. Straightforward path to managed Postgres.

## ADR-008: Admin authentication is an environment password

Context. The hackathon needs a working admin area within hours; conferences
usually have a handful of trusted operators.

Decision. `ADMIN_PASSWORD` checked at `/admin/login`, HMAC-signed HttpOnly
cookie, `protectedProcedure` in tRPC. Better Auth with accounts and roles is a
backlog item behind the same procedure boundary.

Consequences. No user management, one shared credential; acceptable for the
threat model of a venue network. Rotate the password per event.

## ADR-009: OBS integration is a transparent web page

Context. OBS, vMix and most encoders render browser sources; per-tool protocols
(obs-websocket captions, NDI) reach fewer tools and need more code.

Decision. `/overlay/[slug]` with a transparent background and URL parameters
for layout. obs-websocket `SendStreamCaption` stays in the backlog.

Consequences. Zero install for operators, one page to style. Burned-in
captions are not available as a closed-caption track on platforms unless the
backlog item ships.

## ADR-010: Biome instead of ESLint and Prettier

Context. create-t3-app offers both. Several agents will format code
concurrently; a single fast tool with one config reduces churn.

Decision. Biome for linting and formatting in `apps/web`. `gofmt` plus
`staticcheck` in the pipeline.

Consequences. Fewer plugins available than ESLint; acceptable for this codebase.

## ADR-011: Gemini as the demo and MVP speech provider

Context. The owner decided on 2026-09-25 to run the Vibeathon demo and the MVP
over a cloud model: the Gemini API. The brief recommends Gemini audio in the
first place; the local-first choice (ADR-002) had been made to satisfy the
"100% local" option, but running Gemma 4 needs a GPU the demo timeline cannot
guarantee. The provider interface was already designed so that backends are
interchangeable by configuration.

Decision. `PROVIDER=gemini` is the demo and MVP inference path: the pipeline
calls the Gemini `generateContent` API with the chunk WAV as `inlineData`,
authenticated by `GEMINI_API_KEY`, model selected by `GEMINI_MODEL`. The same
ASR/AST/translate prompts are sent. The local path (`openaicompat` against
llama-server or vLLM serving Gemma 4) remains documented and becomes the
self-hosted deployment option; its implementation tasks (M0-08, M1-10) leave
the critical path.

Consequences. The demo needs only outbound internet and an API key; no GPU,
model download or sidecar. Latency now includes a network round trip and is
bounded by API rate limits rather than VRAM. Audio leaves the venue's hardware
for inference, which the local path avoids. `INFERENCE_URLS` and
`INFERENCE_AUDIO_FORMAT` apply only to the local provider.

## ADR-012: One shared provider scheduler for all sessions

Context. M1-11 gave every session runner a private `INFERENCE_MAX_CONCURRENCY`
semaphore, so N sessions multiplied provider load by N and no fairness existed
between sessions; each idle runner also spun its dispatch loop on the
always-ready semaphore. M2-01 needs concurrent sessions sharing one provider
budget.

Decision. The session registry owns a single scheduler goroutine holding the
`INFERENCE_MAX_CONCURRENCY` budget for the whole pipeline. It pops chunks
round-robin over the runners' queues and spawns short-lived workers that
deliver results on each runner's buffered channel; runners keep per-session
ordering, emission, heartbeat and stats. `Registry.Shutdown` stops all runs
in parallel for process teardown.

Consequences. `INFERENCE_MAX_CONCURRENCY` now means in-flight provider calls
across all sessions combined, not per session — matching what Gemini rate
limits and llama-server `--parallel` actually bound. Idle pipelines consume
no CPU in scheduling. Run ordering is still guaranteed per session by the
runner's outstanding-index tracker; the scheduler only chooses which session
gets the next slot.
## ADR-013: Clean replay EOF drains to idle instead of erroring

Context. M1-14's first real run exposed that a non-looping `file_replay`
reaching end of file put the session in `error` and left the buffered tail
chunk in the chunker until an operator pressed stop. The tail's `latencyMs`
then measured operator reaction time, not pipeline latency, and a completed
demo replay looked like a failure on the dashboard.

Decision. `ExitedError` with exit code 0 (ffmpeg finished the input) now logs
`ffmpeg_exit` at info level and drives the same wind-down as a stop request:
flush the tail, drain the queue, emit, end `idle`. Non-zero exits keep the
error path unchanged.

Consequences. Replay sessions self-complete with correct tail latency and a
clean final status; `ffmpeg_exit` appears at two levels (info for natural
EOF, error for real failures). Live sources (browser mic, stream URLs) are
unaffected — their producers only return on cancellation.

## ADR-014: Video served by a slug-scoped media route, cues keyed to `currentTime`

Context. M7-01 needs the browser to play the same video file the pipeline
replays. `FIXTURES_DIR` belongs to the pipeline and the audience surface is
public, so neither exposing the directory nor hardcoding `public/` symlinks
(FIXTURES_DIR is configurable; Windows symlinks are awkward) was attractive.

Decision. `GET /api/media/[slug]` resolves the session, re-validates
`sourceConfig.path` (relative, no `..`, video extension) and streams it from
the web app's own `MEDIA_DIR` with single-range support. The playback view at
`/s/[slug]/play` is seekable rather than live-locked: cues are selected by
`video.currentTime` against segment `startMs`/`endMs`, with a 2 s linger past
`endMs` so translations that arrive after their audio window still render.

Consequences. Only files referenced by a session's source are reachable over
HTTP; `MEDIA_DIR` must point at the fixture tree (default matches the repo
layout). Live viewing is "press play whenever", not locked to run start —
segments produced before the viewer seeks are simply all available.

## ADR-015: Profile `all` is the application stack only

Context. M2-05 needed `docker compose --profile all up` to work on any clean
machine. The Vulkan `llama` service requires `/dev/dri`, which Docker Desktop
on WSL2 does not provide (`/dev/dxg` instead), so including `llama` in `all`
made the profile fail on exactly the laptops it will be verified on — and the
Gemini path (ADR-011) never needs it.

Decision. `all` runs `postgres`, `web` and `pipeline`. Local inference joins
the stack by combining profiles: `--profile all --profile infra` (Vulkan) or
`--profile all --profile cpu`. `llama` keeps the `infra` profile,
`llama-cpu` keeps `cpu`.

Consequences. The acceptance run works with only `PROVIDER=mock` and no GPU
or model download. Event deployments that self-host inference add one flag.
Docs (`deployment.md`, `stack.md`) were updated to match.
## ADR-015: Speaker labels come from prompt tags, not diarization

Context. M7-02 needed speaker attribution on captions. Real diarization
(pyannote-style) needs a separate model pass with cross-chunk speaker state,
which the chunker/provider boundary does not carry; it is also another model
to host on the local path. Meanwhile the AST/ASR models already hear the
chunk and can name the voice they transcribed.

Decision. The ASR and AST prompts ask the model to prefix its transcript with
a speaker tag (`S1: `, `S2: `, ...) numbering voices in order of appearance.
The provider strips the tag into `Transcript.Speaker`; the runner copies it
onto the `speaker` field of the chunk's original and translation events
(contract v2). The web app maps `S<n>` deterministically onto the branding
accent palette (`S1` -> `cyan`, cycling).

Consequences. Speaker identity is best-effort within a chunk: the model sees
one chunk at a time, so the same voice can receive different labels across a
session, and overlapping speakers yield one tag. The contract field stays
optional so providers that never tag simply omit it. When a real diarization
pass lands (backlog), it can write the same `speaker` field without touching
the web app.
