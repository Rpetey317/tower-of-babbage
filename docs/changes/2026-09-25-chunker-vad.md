# Chunker and energy VAD (M1-07)

Added `services/pipeline/internal/chunk`:

- `frame.go`: `Frame` (PCM + `StartMs`) and `Clock`, which counts samples and
  stamps audio-millisecond positions (`audioReceivedMs` per ingest.md).
- `wav.go`: `EncodeWAV`, the 44-byte RIFF header + s16le payload sent to
  providers.
- `vad.go`: `VAD` classifies 20 ms windows (640 bytes) as speech when RMS >
  floor × 3 **and** > 100 RMS (~-44 dBFS, rejects quiet room noise). The floor
  is an exponential moving minimum: it drops to a new minimum in ~100 ms
  (`downAlpha` 0.5) and forgets minima over ~80 s of louder audio (`upAlpha`
  0.0001), so sustained speech never raises it within one chunk.
- `chunker.go`: `Chunker` buffers arbitrary-size pushes, forms windows, and
  applies the ingest.md cut rules once per frame: no cuts before
  `CHUNK_MIN_SECONDS`; after `CHUNK_TARGET_SECONDS` the first pause >= 250 ms
  cuts; a pause >= 1.5 s cuts immediately; at `CHUNK_MAX_SECONDS` it cuts at
  the end of the lowest-energy window within the last second (ties take the
  latest, so uniform energy cuts exactly at Max). Pause cuts end the chunk at
  the pause start. Chunks under 5% speech ratio are discarded without
  consuming an index; `Flush` emits the tail when it meets Min.

Verification: `go test ./internal/chunk/` — synthetic signals cover cuts
inside silences, the immediate 1.5 s pause cut below Target, no cuts below
Min, hard cuts at Max under a constant-energy signal, discarded silent chunks
(the clock still advances: the next chunk keeps its position), the <5%
speech-ratio rule, sub-Min flush drops, arbitrary frame sizes, VAD adaptation,
WAV header fields, and the golden replay: `en-kubernetes-60s.wav` (62192 ms)
yields exactly 7 chunks whose boundaries all land inside measured silence
regions and cover the file end to end.
