# M1-14: first real caption session

- `scripts/wer.mjs`: zero-dependency WER tool promised by testing.md —
  `wer.mjs <exported.txt> <ground-truth.txt>` lowercases, strips punctuation
  and reports `WER = (S+D+I)/N` with substitution/deletion/insertion counts.
- `internal/session`: a clean producer exit (`ExitedError` with exit code 0,
  i.e. a non-looping `file_replay` reaching end of file) now logs
  `ffmpeg_exit` at info level and winds the run down like a stop request —
  the buffered tail flushes and the run drains to `idle`. Previously any
  ffmpeg exit error'd the run and the tail chunk sat in the chunker until a
  manual stop, which inflated tail `latencyMs` arbitrarily. Non-zero exits
  still error. New tests cover both exits. `docs/components/ingest.md`
  updated; reasoning in ADR-013.
- `GEMINI_MODEL` default `gemini-2.5-flash` -> `gemini-3.8-flash`: the 2.5
  generation is retired for new keys (HTTP 404 "no longer available to new
  users"); 3.x ids resolve (HTTP 402 on the unfunded key). Updated in
  `config.go`, both `.env.example` files, `transcribe-file-gemini.sh`,
  `stack.md`, `speech-engine.md`. `gemini-3.5-flash-lite` documented as the
  cheaper option.
- Real run recorded in issue #22: `demo-en` 60 s replay end to end against
  `openaicompat` on the local llama-server (Gemma 4 E2B, CPU) — the Gemini
  key's prepaid credits are depleted (402 on every current model, same wall
  M1-16 hit). Warm run: 7 original + 7 translation segments, p50 3.1 s,
  p95 4.8 s, max 5.0 s, WER 1.32%, no parse failures, ends `idle`.
- Verification: `go test ./...` (incl. new EOF-drain tests), `go vet`,
  `staticcheck`, `pnpm lint`, `pnpm test` (180), `make smoke` PASS in 39.6 s
  on this clone's stack (web :3100, pipeline :8095, db `babbage_dev_m114`).
  Manual check: `pnpm db:seed`, start `demo-en` from `/admin`, watch
  `/s/demo-en` — Spanish captions arrive ~3-5 s behind the audio.
