# Operator page (M1-06)

Added `/admin/sessions/[id]/operator`, the browser microphone producer for
`browser_mic` sessions (contract section 4, `docs/components/ingest.md`).

- `operator-console.tsx` (client): `getUserMedia` with processing constraints
  off by default and a checkbox to enable echo/noise/auto-gain (restarts the
  capture only); `AudioContext({ sampleRate: 16000 })` plus a thin
  `public/operator-mic.worklet.js` `AudioWorkletProcessor` that forwards raw
  Float32 blocks to the main thread. Deviation from the doc: resample, Int16
  conversion and 200 ms framing happen on the main thread in
  `src/lib/pcm.ts` (`PcmFramer`) so the DSP is unit-tested; the worklet stays
  a copy-only forwarder. ingest.md updated accordingly.
- WebSocket flow: fresh `admin.ingestToken` on every connect attempt, `hello`
  on open, queued frames flush on `ready`, `stats` feed the `audioReceivedMs`
  / `queueDepth` readout, `end` is sent on stop. Close codes are surfaced;
  4004 shows "session not running". Auto-reconnect with 1 s -> 5 s backoff
  and a manual reconnect button.
- `ConnectionPill` moved to `src/app/_components/` and shared with the
  audience caption view.
- Session detail page links to the operator page; `es`/`en` dictionaries grew
  the `adminOperator`/`operator*` keys (inserted mid-file to reduce conflicts
  with the parallel M2-03 work).

Verification: `pnpm test` (new `pcm.test.ts` covers frame sizing, RMS,
clamping and 48 -> 16 kHz resampling), `pnpm lint`, `pnpm typecheck`, plus a
Node harness that logs in, creates/starts a `browser_mic` session and streams
PCM over the ingest socket to check `audioReceivedMs` grows at wall-clock
rate and that reconnect after a pipeline kill works. The two-minute real-mic
check in Chromium/Firefox stays manual (needs a browser and microphone).
