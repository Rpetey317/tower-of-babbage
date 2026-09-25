# M4-03: glossary quality measurement

- New fixture `fixtures/audio/en-glossary-30s` (28 s, Piper
  `en_US-ljspeech-medium` per the LICENSES.md recipe): a script that says
  `kubectl`, `etcd`, `Nerdearla` several times each — the existing
  `en-kubernetes-60s` fixture never says them, so glossary spellings were
  not observable before. `.txt` ground truth and `.mock.txt` included;
  LICENSES.md and the testing.md fixture table updated.
- `scripts/glossary-quality.mjs`: zero-dependency measurement runner. For
  each scenario it spawns the pipeline on its own ports (default :8091,
  sink :8399) with `PROVIDER=gemini`, stands in for the web app with a
  minimal `/api/internal/events` sink, starts a `file_replay` session via
  the control API, waits for the terminal `status`, then writes the
  transcripts and a WER/spelling report (via `scripts/wer.mjs`) to
  `$TMPDIR/tower-of-babbage-glossary-quality` (override with `OUT_DIR`).
  Needs `SHARED_SECRET` + `GEMINI_API_KEY` in env (source
  `services/pipeline/.env`).
- Results recorded in issue #33 and summarized in
  `docs/components/glossary.md`: on the new fixture the glossary prompt
  cuts WER 8.57% -> 1.43% (fixes `etcd` -> "it could"/"it" and `Nerdearla`
  -> "Nerdio"); `GLOSSARY_ENFORCE` produced identical output, so the
  default stays `false`. An absent-term glossary on `en-kubernetes-60s`
  changed nothing (0.66% WER both ways, no leaked terms) but roughly
  doubled segment p50 latency.
- Verification: `node scripts/glossary-quality.mjs` output (report in
  `results.md` under OUT_DIR), `ffprobe` on the new WAV (16 kHz mono s16le,
  28.5 s), `make lint`, `make test`.
