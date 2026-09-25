# Testing and verification

Every change needs a reproducible check ([AGENTS.md](../AGENTS.md) section 6).
This document says which kind of check applies where and what shared tooling
exists.

## Matrix

| Area | Tool | What is covered |
| --- | --- | --- |
| Contract | Go `testing` + Vitest, fixtures in `packages/contract/fixtures` | Both sides parse and round-trip every fixture; ingest-token vector reproduced byte for byte |
| Pipeline logic | Go `testing` | Chunker cut rules, energy VAD, WAV encoding, prompt rendering, AST parsing, round-robin and health marking (`httptest`), session runner backpressure |
| Web logic | Vitest | Export (golden files), chunk-merging reducer, cookie signing, locale resolution, dictionary parity, Zod schemas |
| Route handlers | Vitest with a test database (`DATABASE_URL_TEST`) | Events endpoint (auth, atomic batch, upsert), export route, health |
| End to end | `scripts/smoke.sh` | Replay -> pipeline (mock) -> web -> SSE -> export, without a model |
| Model quality | `scripts/transcribe-file.sh` (local path; a Gemini variant ships with the provider task), `scripts/wer.mjs` | Manual, per language pair, against fixture ground truth |
| Windows inference scripts | `scripts/windows-inference.test.ps1` (also via `.\dev.ps1 test-inference`) | `dev.ps1`, `infra/pull-model.ps1`, `infra/start-inference.ps1` and `scripts/transcribe-file.ps1` against a stub HTTP server, stub `ffmpeg` and a compiled `llama-server` stub, including `infra/.env` / `.env.example` sourcing through `infra/env.ps1`; no model, no network beyond localhost |
| Performance | `scripts/bench-latency.sh` | Latency percentiles for N parallel sessions on real hardware |
| UI | Manual checklists in component docs; Playwright in the backlog | Audience, admin, overlay |

Commands: `make test` (unit and route tests), `make lint`, `make smoke`.

## Fixtures

`fixtures/audio/` holds short speech samples with their ground truth:

| File | Content |
| --- | --- |
| `en-kubernetes-60s.wav` | 60 s, English, technical talk excerpt read aloud, 16 kHz mono |
| `en-glossary-30s.wav` | 30 s, English, repeats `kubectl`, `etcd`, `Nerdearla` for the glossary quality check (`scripts/glossary-quality.mjs`) |
| `es-charla-60s.wav` | 60 s, Spanish (Rioplatense), same kind of content |
| `pt-sample-30s.wav` | 30 s, Portuguese (Brazil), for the pt language quality check (`scripts/language-quality.mjs`) |
| `<name>.txt` | Ground-truth transcript, one paragraph |
| `<name>.mock.txt` | Lines the mock provider returns for successive chunks |
| `LICENSES.md` | Provenance and license of every sample |

Producing samples: record a team member reading the `.txt` script (licensed
under the project license), or synthesize it with an open TTS engine such as
Piper (`piper --model <voice> --output_file en-kubernetes-60s.wav < en-kubernetes-60s.txt`).
Synthesized speech gives exact ground truth for WER checks; recorded speech is
closer to reality. Keep both when possible, named `-tts` and `-rec`. Public
corpora are acceptable only with a permissive license noted in `LICENSES.md`
(LibriSpeech is CC BY 4.0; Common Voice is CC0).

`packages/contract/fixtures/` is described in [contract.md](contract.md) section 7.

## Smoke test (`scripts/smoke.sh`)

Preconditions: Postgres up, web running on `:3000`, pipeline running with
`PROVIDER=mock` on `:8090`, `ADMIN_PASSWORD` and `SHARED_SECRET` exported.
When running against the compose `all` stack the wrapper fills any unset
variable (`ADMIN_PASSWORD`, `SHARED_SECRET`, `WEB_URL` from `PUBLIC_WEB_URL`,
`PIPELINE_URL` from `PUBLIC_PIPELINE_WS_URL`) from `infra/.env`; exported
values always win. The script wraps `scripts/smoke.mjs` (Node 22, no
dependencies):

1. Log in at `/admin/login`, keep the cookie.
2. Create session `smoke-<timestamp>` with `sourceType: file_replay`,
   `path: en-kubernetes-60s.wav`, `en -> es`, through the tRPC HTTP endpoint.
3. Start it; poll `sessions.bySlug` until `running` (max 10 s).
4. Open the SSE subscription until at least 3 `original` and 3 `translation`
   segments arrive (default deadline 40 s, `SMOKE_SSE_SECONDS`); require
   increasing `chunkIndex` and `latencyMs` under 2000 for the mock. Under the
   default chunk cut rules the fixture's third chunk lands near 30 s, so the
   window is a deadline, not a fixed wait.
5. Stop; export SRT for `es`; require at least 3 cues with valid timestamps.
6. Delete the session. Exit non-zero with a clear message on any failed step.

Target runtime under 60 s. Used as the merge gate for anything touching the
end-to-end path.

## Model checks

- `scripts/transcribe-file.sh <wav> [source] [target]` (on native Windows:
  `.\scripts\transcribe-file.ps1 <wav> [source] [target]`): cuts the first 10 s,
  sends one AST request to `INFERENCE_URLS` (local path), prints the raw model
  output and the parsed transcript and translation. First thing to run on a
  new machine. The Gemini variant does the same against `GEMINI_API_KEY`.
  `scripts/windows-inference.test.ps1` (or `.\dev.ps1 test-inference`) verifies
  the PowerShell scripts offline on Windows PowerShell 5.1+ and exits non-zero
  on any failure.
- `scripts/wer.mjs <exported.txt> <ground-truth.txt>`: word error rate after
  lowercasing and stripping punctuation. Not a gate; recorded in the roadmap
  task notes when tuning chunk sizes or prompts.
- `scripts/language-quality.mjs <fixture.wav> <source> <target>`: replays a
  fixture through a real pipeline (default `PROVIDER=gemini`, works with
  `openai-compat` too) via the control API and a stub events sink, then
  reports segments, latency percentiles and WER. Per-language-pair variant of
  `scripts/glossary-quality.mjs`; no web app or database needed.

## Latency benchmark

`scripts/bench-latency.sh <sessions> [seconds]` seeds `<sessions>` replay
sessions with `loop: true`, runs them for the given time (default 120 s), then
queries `segments` for p50/p95 `latencyMs`, `chunksDropped` and throughput per
session, and prints a table. Run it on the demo machine with 1, 2 and 4 sessions to
fill the capacity table in [deployment.md](deployment.md).

## Conventions

- Tests live next to the code (`*_test.go`, `*.test.ts`).
- Golden files are committed; regenerate with `UPDATE_GOLDEN=1`.
- No test depends on a running model. Anything that does is a script, not a test.
- Route tests use a dedicated database and truncate tables between tests.
