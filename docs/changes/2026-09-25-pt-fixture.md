# M6-03: Portuguese fixture and pt -> es quality check

- New fixture `fixtures/audio/pt-sample-30s` (29.8 s, Piper
  `pt_BR-faber-medium` per the LICENSES.md recipe): a Brazilian Portuguese
  script on the same live-captions demo theme as the en/es fixtures. `.txt`
  ground truth and `.mock.txt` included; LICENSES.md and the testing.md
  fixture table updated.
- `scripts/language-quality.mjs`: zero-dependency per-language-pair
  measurement runner, same shape as `scripts/glossary-quality.mjs`. Spawns
  the pipeline on its own ports (default :8093, sink :8393), stands in for
  the web app with a minimal `/api/internal/events` sink, starts a
  `file_replay` session via the control API and reports segments, latency
  percentiles and WER (via `scripts/wer.mjs`). `PROVIDER` selects the speech
  provider (`gemini` default; `openai-compat` verified).
- Quality check `pt -> es` recorded in issue #38 and summarized in
  `docs/components/languages.md`: 8 segments, 0 parse failures, terminal
  `idle`; WER 1.03% on Gemini `gemini-3.8-flash` (p95 2070 ms) and 3.09% on
  the local llama-server path (p95 9185 ms, shared CPU). Both transcripts
  are clean Portuguese and both translations clean Spanish.
- Verification: `node scripts/language-quality.mjs pt-sample-30s.wav pt es`
  output (artifacts under OUT_DIR), `ffprobe` on the new WAV (16 kHz mono
  s16le, 29.8 s), `make lint`, `make test`.
