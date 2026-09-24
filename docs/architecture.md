# Architecture

## Goals

- Real-time captions (original language plus translations) for many stages at once.
- Fully local by default: the only model dependency is a Gemma 4 model served on
  hardware you control. Cloud providers (Gemini) plug into the same interface.
- Deployable by any conference with Docker and one config file.
- Clear boundaries so several people or agents can work in parallel.

## Components

```mermaid
flowchart LR
  subgraph sources [Audio sources]
    Mic[Operator browser mic]
    FileReplay[File replay via ffmpeg]
    StreamUrl[Stream URL / device - backlog]
  end
  subgraph pipeline [services/pipeline - Go]
    Ingest["Ingest: WS + PCM 16 kHz mono"]
    Chunker["Chunker + VAD, up to 30 s"]
    Provider["SpeechProvider: openai-compat, mock, gemini"]
    Emitter[Event emitter]
    Control[Control API]
  end
  subgraph inference [Inference sidecar]
    Llama["llama-server: Gemma 4 E2B, Vulkan"]
  end
  subgraph web [apps/web - T3]
    Internal[Internal events endpoint]
    DB[(Postgres via Drizzle)]
    Bus[In-memory event bus]
    Trpc[tRPC queries + SSE subscriptions]
    Admin[Admin panel + operator page]
    Audience[Audience view]
    Overlay[OBS overlay page]
    Export[SRT / VTT / TXT export]
  end
  Mic -->|"WS, PCM s16le"| Ingest
  FileReplay --> Ingest
  StreamUrl -.-> Ingest
  Ingest --> Chunker --> Provider
  Provider <-->|"HTTP chat completions"| Llama
  Provider --> Emitter -->|"POST /api/internal/events"| Internal
  Admin -->|"POST /v1/sessions/:id/start and stop"| Control
  Internal --> DB
  Internal --> Bus --> Trpc --> Audience
  Trpc --> Overlay
  DB --> Export
```

| Component | Responsibility | Not responsible for |
| --- | --- | --- |
| Web app (`apps/web`) | Source of truth for sessions, segments, glossary. Public pages. Admin. Control-plane calls to the pipeline. Fan-out of segments to browsers. | Touching audio, calling models |
| Pipeline (`services/pipeline`) | Everything between audio bytes and text segments: ingest, chunking, provider calls, latency accounting, per-session runners. | Persistence, public UI, auth of end users |
| Inference sidecar | Serving Gemma 4 through an OpenAI-compatible API. Interchangeable: llama-server, vLLM, or a hosted Gemini endpoint through the provider layer. | Anything domain-specific |
| Postgres | Storage for the web app only. | Being reached by the pipeline |

## Data flow for one session

```mermaid
sequenceDiagram
  participant A as Admin browser
  participant W as Web app
  participant P as Pipeline
  participant L as llama-server
  participant U as Audience browser
  A->>W: start session (tRPC admin.sessions.start)
  W->>P: POST /v1/sessions/{id}/start (runId, languages, source, glossary)
  P-->>W: 202 accepted
  P->>W: POST /api/internal/events [status: running]
  A->>P: WS /v1/sessions/{id}/ingest?token=... (PCM frames)
  loop every chunk (3-10 s of speech)
    P->>L: chat completion with input_audio + AST prompt
    L-->>P: "transcript\nSpanish: translation"
    P->>W: POST /api/internal/events [segment original, segment translation, status]
    W->>W: insert segments, publish on bus
    W-->>U: SSE event (tRPC subscription segments.onSegment)
  end
  A->>W: stop session
  W->>P: POST /v1/sessions/{id}/stop
  P->>W: POST /api/internal/events [status: idle]
```

Key properties:

- The web app is the single writer to Postgres. The pipeline is stateless across
  restarts except for in-flight audio; a restarted pipeline receives `start`
  again from the admin panel.
- Segments are idempotent on `(sessionId, runId, chunkIndex, language)`. The
  pipeline may retry a batch; the web app upserts.
- Time inside a run is audio time (`startMs`, `endMs` since run start), derived
  from sample counts, so exports are exact regardless of processing delays.

## Runtime topologies

| Topology | Where things run | Use |
| --- | --- | --- |
| Laptop dev | Everything on one machine. `PROVIDER=mock` or llama-server on CPU (E2B, 1 session near real time). | Development, UI work, tests |
| Laptop + GPU box | Web, pipeline and Postgres on the laptop; llama-server on a LAN machine with a GPU (`INFERENCE_URLS=http://gpu-box:8080`). | Vibeathon demo |
| Event server | One machine with a GPU runs `infra/compose.yml`: Postgres, llama-server, pipeline, web. Operators and audience connect over the venue network or the internet. | Conference deployment |
| Scaled event | Several llama-server instances (one per GPU) listed in `INFERENCE_URLS`; the pipeline round-robins per session. Web app still single instance. | 10+ stages |

## Scaling model

- One session = one runner goroutine group inside the pipeline: ingest reader,
  chunker, a bounded request queue, one or more provider workers, an emitter.
- Provider capacity is expressed as `INFERENCE_URLS` (endpoints) times
  `INFERENCE_MAX_CONCURRENCY` (in-flight requests per endpoint, matched to
  llama-server `--parallel`).
- Backpressure: when a session's request queue is full the chunker merges the
  next chunk into a longer one (up to `CHUNK_MAX_SECONDS`, never past 30 s), then
  drops the oldest unprocessed chunk and emits a `log` event with code
  `chunk_dropped`. Captions lag rather than the process falling over.
- The web app's fan-out is an in-process bus. For multiple web instances, swap
  the bus for Redis pub/sub (see [components/realtime.md](components/realtime.md)).

## Latency budget

Target on the demo hardware (RX 6600, Gemma 4 E2B Q4): p95 under 10 s from
words spoken to translated caption visible, one to two live sessions.

| Stage | Typical | Notes |
| --- | --- | --- |
| Chunk accumulation | 1.5-5 s | Half the chunk length on average; pause snapping shortens it |
| Audio encode + prompt eval | 0.3-1 s | ~6 audio tokens per second of speech plus prompt |
| Generation | 0.5-2 s | Transcript plus translation, ~40-80 tokens per chunk |
| Emit, persist, SSE | < 0.2 s | LAN |

Levers: `CHUNK_TARGET_SECONDS` (shorter chunks reduce latency and quality),
model size (E2B vs E4B), quantization, GPU backend, number of endpoints.

## Failure handling

| Failure | Behaviour |
| --- | --- |
| Inference endpoint down | Provider marks endpoint unhealthy, retries others, emits `log` `provider_unavailable`; session status `error` with `lastError` until recovery |
| Pipeline crash | Sessions show `error` after the web app's status timeout (no status event for 15 s); admin restarts |
| Web app down | Pipeline buffers events in memory up to a cap and retries with backoff; audience reconnects and catches up via `segments.recent` |
| Operator browser disconnects | Runner keeps the session `running` with a `no_audio` warning; reconnection resumes the same run |
