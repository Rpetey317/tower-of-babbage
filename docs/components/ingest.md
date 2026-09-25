# Ingest and chunking

Location: `services/pipeline/internal/ingest`, `services/pipeline/internal/chunk`,
operator page in `apps/web/src/app/admin/sessions/[id]/operator`.

Everything that enters the pipeline is normalized to one representation: mono,
16 kHz, signed 16-bit PCM frames stamped with audio time. Sources differ only
in how they produce those frames.

## Sources

| `sourceType` | Milestone | `sourceConfig` | Producer |
| --- | --- | --- | --- |
| `browser_mic` | M1 | `{}` | Operator page captures the microphone and streams PCM over the ingest WebSocket ([contract](../contract.md) section 4) |
| `file_replay` | M1 | `{"path":"en-kubernetes-60s.wav","loop":false}` | Pipeline spawns `ffmpeg -re` on a file under `FIXTURES_DIR` |
| `stream_url` | backlog | `{"url":"rtmp://…"}` or HLS/SRT/YouTube URL | Same ffmpeg path without `-re` |
| `device` | backlog | `{"device":"default","backend":"pulse"}` | `ffmpeg -f pulse -i default` (or `alsa`, `pipewire`) |

`file_replay` exists so that tests, demos and multi-session load runs need no
human at a microphone. Paths are resolved under `FIXTURES_DIR` only; absolute
paths and `..` are rejected.

## Browser capture (operator page)

1. `getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`.
   Processing is off by default because the input is usually a mixer feed or a
   microphone pointed at the PA; a toggle enables it for laptop mics.
2. `new AudioContext({ sampleRate: 16000 })`. Modern Chromium, Firefox and Safari
   honor the requested rate; if `context.sampleRate` differs, the page
   resamples linearly.
3. An `AudioWorkletProcessor` forwards raw Float32 blocks to the main thread,
   where `src/lib/pcm.ts` resamples, converts to Int16 and accumulates 200 ms
   frames (3200 samples, 6400 bytes) that are sent on the WebSocket as binary
   messages. Conversion lives on the main thread so it stays unit-testable.
4. The page shows: connection state, level meter, `audioReceivedMs` from the
   server `stats` messages, and reconnects automatically with a fresh token when
   the socket drops.

The page mints a token with `admin.ingestToken({ sessionId })` before
connecting; tokens last 10 minutes and are refreshed on reconnect.

## ffmpeg producers

```
ffmpeg -hide_banner -loglevel error -re [-stream_loop -1] -i <path> -f s16le -ac 1 -ar 16000 -
```

Stdout is read in 6400-byte frames. Process exit before `stop` emits a
`ffmpeg_exit` log event and puts the session in `error`. `-re` paces the file
at real time so latency measurements are meaningful; stream URLs are already
real time and omit it.

## Audio clock

`audioReceivedMs = samplesReceived / 16`. Frames carry `startMs` computed from
the running sample count, so `startMs` and `endMs` on segments are exact audio
positions since the run started, independent of network jitter or processing
delay. Wall clock enters only through `emittedAt`, and
`latencyMs = emittedAt - (runStartedAtWall + endMs)`.

## Chunker

The model accepts at most 30 s per request, and shorter chunks mean lower
latency. The chunker turns the frame stream into `Chunk{index, startMs, endMs, pcm}`:

1. Frames are appended to a buffer. Energy VAD classifies each 20 ms window as
   speech or silence using RMS against an adaptive noise floor
   (exponential moving minimum times a factor, default 3x).
2. Cut rules, evaluated per incoming frame:
   - never cut before `CHUNK_MIN_SECONDS` of buffered audio (default 2 s);
   - after `CHUNK_TARGET_SECONDS` (default 6 s), cut at the first pause of at
     least 250 ms;
   - a pause of 1.5 s or more cuts immediately once the minimum is met (end of
     sentence);
   - at `CHUNK_MAX_SECONDS` (default 15 s, hard limit 30 s), cut at the
     lowest-energy window within the last second.
3. Chunks whose speech ratio is below 5% are discarded without a model call; the
   clock still advances so timestamps stay correct.
4. The pipeline's `stop` and the WebSocket `end` message flush whatever is
   buffered if it meets the minimum length.

Chunks are serialized as 16-bit PCM WAV (44-byte header) and base64-encoded
for the provider. A 6 s chunk is about 256 KB of base64.

## Backpressure

Each session runner has a bounded chunk queue (default 4). When it is full,
the chunker extends the current chunk up to `CHUNK_MAX_SECONDS`; if it is still
full, the oldest queued chunk is dropped with a `chunk_dropped` log event. See
[architecture.md](../architecture.md), Scaling model.

## Backlog

- Silero VAD through ONNX Runtime for robust speech detection in noisy rooms.
- Optional overlap between chunks with deduplication of repeated words.
- Automatic gain normalization before encoding.
- `stream_url` and `device` sources (same ffmpeg path, different arguments).

## Verification

- Unit tests in `internal/chunk` with synthetic signals: sine bursts separated by
  silences must produce chunks whose boundaries fall inside the silences; a
  30 s continuous tone must produce cuts at `CHUNK_MAX_SECONDS`.
- Replay test: `fixtures/audio/en-kubernetes-60s.wav` through the chunker yields
  a stable chunk count (golden value in the test) and total duration equal to
  the file length within one frame.
- Operator page: manual check listed in the roadmap task; `audioReceivedMs`
  must grow at wall-clock rate.
