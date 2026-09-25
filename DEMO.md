# Demo guide for evaluators

Six scenarios that exercise the project end to end, ordered from quickest to
deepest. Everything except scenario 6 runs on the deterministic mock provider —
no model, GPU or API key needed.

## Before you start

Complete the [README quick start](README.md#quick-start) so that:

- Postgres is up (`docker compose --env-file infra/.env -f infra/compose.yml --profile infra up -d postgres`),
- the schema is pushed and demo sessions are seeded (`make db-push && pnpm --dir apps/web db:seed`),
- the web app is on http://localhost:3000 (`make web`),
- the pipeline is on :8090 with `PROVIDER=mock` (`make pipeline`).

Seeded sessions: `demo-en` (English talk -> Spanish captions),
`demo-es` (Spanish talk -> English captions) and `demo-video` (English video
-> Spanish captions). Admin password is `change-me` (the `.env.example`
default).

## 1. `make smoke` — the whole pipeline in under a minute

```bash
make smoke
```

One command drives a real run through the public surface: admin login, session
create/start over tRPC, segment delivery over SSE, SRT export, stop and delete.
Expected output is step-by-step `[<s>s]` logs ending in success; each emitted
segment reports `latencyMs` under 2000 with the mock provider.

What it proves: web <-> pipeline contract, database writes, realtime fan-out and
export all work together.

## 2. The audience experience — live translated captions

1. Open http://localhost:3000 — the session list shows the rooms with their
   color dots; `demo-en` is greyed out ("not live") until started.
2. Open http://localhost:3000/admin, sign in, press start on `demo-en`.
3. Back on the session list, `demo-en` is now live. Click through to
   `/s/demo-en` — Spanish captions arrive within a couple of seconds of the
   pipeline emitting them.

Things to try on the caption page:

- Language switch: `?lang=en` shows the original transcript; `?lang=es` the
  translation.
- Mode switch or `?mode=both`: original above the translation per chunk.
- `A-` / `A+` font control (16–48 px, persists across reloads).
- `ES`/`EN` toggle in the header (or `?hl=en`): every visible UI string
  switches language.
- Open the same URL on a phone or narrow window — the layout is mobile-first.
  Some chunks carry `Speaker n` labels with accent-colored text.

Do the same with `demo-es` to see the reverse direction (Spanish audio ->
English captions).

## 3. The production view — parallel sessions and monitoring

1. In `/admin`, start `demo-en` and `demo-es` at the same time.
2. Watch the dashboard update live: status pill, `audioReceivedMs` climbing at
   wall-clock rate, queue depth, latency p50/p95 and dropped-chunk counters.
   The pipeline health line reports the provider (`mock`) and active sessions.
3. Open a session page to see the `session_events` log and the export buttons —
   download the same talk as **SRT**, **VTT** or **TXT** per language after the
   run finishes.
4. Failure detection: kill the pipeline process (`Ctrl-C` in its terminal).
   Within ~20 s both sessions flip to `error` with `status_timeout` — the
   watchdog notices the missing heartbeats. Restart `make pipeline`, start the
   sessions again and they recover cleanly.

What it proves: many stages in parallel with per-session isolation, and the
monitoring a production team needs (the Vibeathon "panel de monitoreo"
optional).

## 4. Broadcast output — OBS overlay and video playback

**Overlay** (the Vibeathon OBS/vMix optional):

- While `demo-en` is running, open
  http://localhost:3000/overlay/demo-en?lang=es — outlined captions float on a
  fully transparent background. Try `&lines=3&size=64`, `&align=top`,
  `&bg=none`, `&mode=both`.
- In OBS: Sources `+` > Browser, paste the URL, 1920x1080, leave the source
  filling the frame. Same for vMix (Add Input > Web Browser). Full
  instructions and screenshots: [docs/components/obs-overlay.md](docs/components/obs-overlay.md).

**Video playback**:

- Start `demo-video` (replays `en-kubernetes-60s.mp4`), then open
  http://localhost:3000/s/demo-video/play — the test-pattern video plays with
  captions synced to the playhead. Pause and seek: cue selection follows
  `currentTime` within ~1 s.

## 5. Glossary — fixing the words models get wrong

`fixtures/audio/en-glossary-30s.wav` says `kubectl`, `etcd` and `Nerdearla`
repeatedly. Measured on the Gemini provider (issue #33, replayed with
`scripts/glossary-quality.mjs`):

| Glossary | WER | Effect |
| --- | --- | --- |
| none | 8.57% | `etcd` -> "it could"/"it", `Nerdearla` -> "Nerdio" |
| terms in prompt | 1.43% | every term spelled correctly |

To try it:

1. Create a session in `/admin/sessions/new`: source `file_replay`, path
   `en-glossary-30s.wav`, `en -> es`.
2. On the session page, add glossary terms (`kubectl`, `etcd`, `Nerdearla`) —
   bulk paste accepts `term = translation` per line. Global terms for every
   session live in `/admin/glossary`.
3. Start the session; the merged list goes into every prompt, and edits during
   a run are pushed live to the pipeline (`PUT /v1/sessions/{id}/glossary`) and
   apply to the next chunks.

## 6. Real speech — the Gemini provider (needs `GEMINI_API_KEY`)

The mock provider replays canned lines; the demo/MVP inference path is the
Gemini API, which transcribes and translates each audio chunk in one call.

```bash
GEMINI_API_KEY=<key> PROVIDER=gemini make pipeline
```

Then replay any scenario above — `demo-en` produces a real transcription with
a real Spanish translation. Extras:

- **Talk yourself**: create a session with source type `browser_mic`, open its
  operator page from the session detail (`/admin/sessions/[id]/operator`),
  grant the mic and speak — captions appear live on the audience page.
- **Quality numbers**: export `TXT` for `en` from the session page and run
  `node scripts/wer.mjs <export.txt> fixtures/audio/en-kubernetes-60s.txt`
  against the ground truth. `scripts/language-quality.mjs` does the same for a
  whole run including latency percentiles.
- **A third language**: create a `pt -> es` session pointing at
  `pt-sample-30s.wav` (recorded check: 1.03% WER on Gemini, issue #38).

## Where to look next

| Question | Doc |
| --- | --- |
| How the pieces fit | [docs/architecture.md](docs/architecture.md) |
| What runs where in production | [docs/deployment.md](docs/deployment.md) |
| Wire formats | [docs/contract.md](docs/contract.md) |
| Automated verification | [docs/testing.md](docs/testing.md) |
