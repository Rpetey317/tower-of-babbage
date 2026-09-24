# Tower of Babbage

Open-source, self-hostable real-time transcription and translation for conferences.
Take the live audio of a stage, produce captions in the original language and in
Spanish (or any other target), serve them to the audience on a web page, run many
stages in parallel, and keep everything on your own hardware.

Built for the [Nerdearla 2026 Vibeathon](VIBEATHON.md). Licensed under
[Apache 2.0](LICENSE).

## What it does

- Live captions per session: original language plus one or more translations.
- Audience web view: pick a session, pick a language, read. Works on phones.
- Many sessions in parallel, each with its own audio source.
- Fully local inference with Gemma 4 served by llama.cpp; the same interface
  can be backed by vLLM or Gemini later.
- Admin panel for production staff: create and control sessions, watch
  latency and errors, manage glossaries, export transcripts.
- Optional extras: SRT/VTT/TXT export, technical glossary, OBS/vMix overlay,
  extra languages.

## How it works

```mermaid
flowchart LR
  Mic[Operator browser mic] -->|"WebSocket PCM 16 kHz"| Pipeline
  Replay[File replay via ffmpeg] --> Pipeline
  subgraph Pipeline [services/pipeline - Go]
    Chunker[Chunker + VAD] --> Provider[Speech provider]
  end
  Provider <-->|"OpenAI-compatible HTTP"| Llama["llama-server: Gemma 4 E2B"]
  Pipeline -->|"segment and status events"| Web
  subgraph Web [apps/web - T3]
    DB[(Postgres)]
    SSE[tRPC SSE]
  end
  Web --> Audience[Audience view]
  Web --> Admin[Admin panel]
  Web --> Overlay[OBS overlay]
```

1. An audio source (browser microphone, file replay, later a stream URL) feeds
   16 kHz mono PCM into the Go pipeline.
2. The pipeline cuts audio into chunks of a few seconds at pauses and sends each
   chunk to a speech provider. The default provider is Gemma 4 behind
   llama.cpp's OpenAI-compatible API, which transcribes and translates in one
   call.
3. Resulting segments are pushed to the web app, stored in Postgres and fanned
   out to browsers over Server-Sent Events.

Details: [docs/architecture.md](docs/architecture.md).

## Quick start

Prerequisites: Docker, Node 22 with pnpm, Go 1.24, ffmpeg. A GPU is optional
for development (the mock provider needs no model); Gemma 4 E2B runs
near real time for one session on a modern CPU and comfortably on a consumer GPU.

```bash
# 1. Infrastructure: Postgres + llama-server with Gemma 4 E2B (downloads the model on first run)
make infra-up

# 2. Load the pipeline's local development settings
cp services/pipeline/.env.example services/pipeline/.env
set -a; . services/pipeline/.env; set +a

# 3. Web app and pipeline, in two terminals
make web        # http://localhost:3000, admin at /admin
make pipeline   # control API on :8090, mock provider by default from .env

# To use the local model instead
PROVIDER=openai-compat make pipeline
```

Deployment for an event, hardware guidance and every environment variable:
[docs/deployment.md](docs/deployment.md).

## Repository layout

```
apps/web/           T3 web app: audience view, admin panel, overlay, export, API
services/pipeline/  Go audio pipeline: ingest, chunking, inference, events
packages/contract/  JSON fixtures for the web <-> pipeline contract
infra/              docker compose, Dockerfiles, model download
fixtures/audio/     short speech samples used by tests and demos
scripts/            smoke test and benchmarks
docs/               design docs, roadmap, decisions
```

## Documentation

Start at [docs/README.md](docs/README.md). Agents and contributors: read
[AGENTS.md](AGENTS.md) first, then pick a task from
[docs/roadmap.md](docs/roadmap.md).

## Status

Pre-alpha, under construction during the Vibeathon (September 2026). The
roadmap tracks what exists and what is next.
