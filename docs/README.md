# Documentation index

Reading order for someone new: architecture, contract, domain model, then the
component you will work on, then the roadmap.

## Foundations

| Doc | Content |
| --- | --- |
| [architecture.md](architecture.md) | Components, data flow, runtime topologies, scaling, latency budget |
| [stack.md](stack.md) | Exact technologies per app, tooling, Makefile targets, environment variables |
| [domain-model.md](domain-model.md) | Entities, states, database schema |
| [contract.md](contract.md) | Control API, events API, ingest WebSocket protocol, token scheme, fixtures |
| [decisions.md](decisions.md) | Architecture decision records |

## Components

| Doc | Content |
| --- | --- |
| [components/ingest.md](components/ingest.md) | Audio sources, normalization, chunking, audio clock |
| [components/speech-engine.md](components/speech-engine.md) | Speech provider interface, Gemini (demo/MVP), Gemma 4 via llama.cpp and vLLM, prompts, mock |
| [components/realtime.md](components/realtime.md) | Segment delivery from pipeline to browsers |
| [components/audience-web.md](components/audience-web.md) | Public pages: session list and captions |
| [components/admin-panel.md](components/admin-panel.md) | Session control, operator page, monitoring, glossary, exports |
| [components/export.md](components/export.md) | SRT, VTT and TXT generation |
| [components/glossary.md](components/glossary.md) | Term lists and how they reach the model |
| [components/obs-overlay.md](components/obs-overlay.md) | Browser-source overlay for OBS and vMix |
| [components/languages.md](components/languages.md) | Source and target languages, UI locales |

## Operations and process

| Doc | Content |
| --- | --- |
| [deployment.md](deployment.md) | Compose services, inference (Gemini or local llama-server), hardware guidance, environment |
| [testing.md](testing.md) | Verification matrix, fixtures, smoke test, benchmarks |
| [branding.md](branding.md) | Name, palette, typography, caption legibility |
| [roadmap.md](roadmap.md) | Milestones and issue-ready tasks |
| [context/](context/) | Conversation logs and clarifications that shaped the project |
| [changes/](changes/) | Per-task change summaries awaiting review |
