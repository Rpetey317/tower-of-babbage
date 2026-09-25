# WebSocket and file ingest (M1-08)

New package `internal/ingest` with two producers feeding normalized PCM frames
(`chunk.Frame`) into the session runner.

`websocket.go` serves `GET /v1/sessions/{sessionId}/ingest?token=…` (contract
section 4): ingest-token verification (4001), running-session lookup (4004),
hello with `pcm_s16le`/16000/1 within 5 s (4000), `ready`, binary frames
stamped by the audio clock, `stats` every 2 s, `end` flushing the partial
chunk, one producer per run (replaced conns get 4009 plus an `ingest_replaced`
log event). The hello read runs on its own goroutine under a timer because a
read-context expiry closes the connection in coder/websocket and the 4000
frame would never reach the client.

`replay.go` is the `file_replay` source: paths are restricted to
`FIXTURES_DIR` (`filepath.IsLocal`, must be a regular file), ffmpeg runs
`-re` (`-stream_loop -1` when looping) and its stdout is read in 200 ms
frames. Any ffmpeg exit while the run is active returns `*ExitedError` so the
runner can emit `ffmpeg_exit`; cancelling ctx is the graceful stop.

Seams for M1-11: `Sink` (`RunID`/`Push`/`Flush`/`QueueDepth`), `Sessions` and
`Events` interfaces; `main.go` mounts the route with a nil registry, so every
connection answers 4004 until the runner exists.

Verify: `go test ./internal/ingest/` — WS client tests cover every close code,
producer replacement, ready/stats/end; the replay test streams
`en-kubernetes-60s.wav` through real ffmpeg and checks the received length
within one 200 ms frame.
