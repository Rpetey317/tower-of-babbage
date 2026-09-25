# M2-01: concurrent session runners

- `internal/session/scheduler.go` (new): registry-owned scheduler goroutine
  holding the shared `INFERENCE_MAX_CONCURRENCY` budget. It pops queued chunks
  round-robin over the registered runners and spawns workers that call the
  provider on the runner's context and return results on its buffered channel.
  The loop sleeps on a wake channel when there is no work or no free slot —
  the per-runner dispatch loop that busy-spun when idle is gone.
- `internal/session/runner.go`: the private semaphore and dispatch select-case
  were removed; `run()` now only consumes `results`, heartbeats and drains on
  stop. `outstanding` is guarded by `outMu` and updated atomically with the
  queue pop (`popQueued`) so the stop-drain check can never see an empty queue
  while a chunk is in transit to a worker. `Stop` splits into
  `beginStop`/`waitDone` for parallel shutdown; blocking `Stop()` semantics
  for callers are unchanged.
- `internal/session/registry.go`: owns the scheduler and a base context that
  every run derives `runCtx` from — a run's lifetime no longer depends on the
  `Start` caller's context (matters once M1-12 calls `Start` from an HTTP
  handler). New `Shutdown()`: begins stop on all runs in parallel, waits for
  each to drain to `idle`, then stops the scheduler. `Start`/`Stop`/
  `Sessions`/`Lookup`/`Active` signatures unchanged.
- `cmd/pipeline/main.go`: `registry.Shutdown()` on the graceful path before
  `events.Close()` so final segments and `idle` statuses flush to the web app.
- `Config.MaxConcurrency` now means provider calls in flight across all
  runners (documented; architecture.md scaling model updated).
- `go.uber.org/goleak` added as the leak-check required by the task; a
  `TestMain` in `internal/session` verifies every test leaves no goroutines.

Verification: `go test -race ./internal/session/...` green —
`TestConcurrentSessionsShareProviderCapacity` (4 sessions on a shared budget
of 2: all progress, in-flight calls peak at exactly 2),
`TestSessionStatsIndependent` (per-session counts and `audioReceivedMs` match
each feed), `TestShutdownStopsAllSessions` (4 sessions drain to `idle`, tails
flushed, registry empty). `go test ./...` and `go vet ./...` clean;
staticcheck unavailable on this machine (same as M1-11).
