// Package session owns the per-run session runner: it feeds ingest frames to
// the chunker, queues chunks with backpressure, calls the speech provider,
// and emits segment/status/log events through the emit client. The Registry
// tracks active runs and implements ingest.Sessions. See
// docs/components/ingest.md and contract sections 2, 3 and 6.
package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/ingest"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/provider"
)

// queueSize is the bounded chunk queue per runner (docs/components/ingest.md).
const queueSize = 4

// statusHeartbeat is the maximum interval between status events while a run
// is active; the web app errors a session after 15 s of silence.
const statusHeartbeat = 5 * time.Second

// noAudioAfter reports a no_audio warning once this long without frames.
const noAudioAfter = 10 * time.Second

// latencyWindow bounds the per-chunk latencies kept for p50/p95 stats.
const latencyWindow = 256

// Events is the runner-facing view of the emit client; a fake satisfies it in
// tests. *emit.Client implements it.
type Events interface {
	Segment(sessionID, runID string, ev contract.SegmentEvent)
	Status(sessionID, runID, status string, stats contract.SessionStats)
	Log(sessionID, level, code, message string)
	LogForRun(sessionID, runID, level, code, message string, data json.RawMessage)
	Flush(ctx context.Context)
}

// Config carries the runner tunables derived from the pipeline config.
type Config struct {
	FixturesDir    string
	Chunk          chunk.Config
	MaxConcurrency int           // provider calls in flight across all runners (shared)
	StatusInterval time.Duration // defaults to statusHeartbeat
	NoAudioAfter   time.Duration // defaults to noAudioAfter
	Now            func() time.Time
}

func (c Config) withDefaults() Config {
	if c.MaxConcurrency <= 0 {
		c.MaxConcurrency = 1
	}
	if c.StatusInterval <= 0 {
		c.StatusInterval = statusHeartbeat
	}
	if c.NoAudioAfter <= 0 {
		c.NoAudioAfter = noAudioAfter
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c
}

// AlreadyRunningError reports a start while a different run is active; the
// control API maps it to 409 with the current runId.
type AlreadyRunningError struct{ RunID string }

func (e *AlreadyRunningError) Error() string {
	return fmt.Sprintf("already_running: run %s is active", e.RunID)
}

// NotRunningError reports a stop or lookup with no active run.
var ErrNotRunning = errors.New("not_running")

// ErrShuttingDown reports a start racing with Registry.Shutdown; the run is
// rejected rather than left to linger without anyone able to stop it.
var ErrShuttingDown = errors.New("shutting_down")

// InvalidSourceError reports a source type the pipeline cannot produce
// frames for; the control API maps it to 400 invalid_source.
type InvalidSourceError struct{ Type string }

func (e *InvalidSourceError) Error() string {
	return fmt.Sprintf("invalid_source: unsupported source type %q", e.Type)
}

// UnsupportedLanguageError reports a start request naming a language outside
// the provider's language table; the control API maps it to 400
// unsupported_language.
type UnsupportedLanguageError struct{ Code string }

func (e *UnsupportedLanguageError) Error() string {
	return fmt.Sprintf("unsupported_language: %q", e.Code)
}

// Registry tracks the active run per session and implements ingest.Sessions
// so the WebSocket handler can resolve producers. It owns the shared
// scheduler and the base context every run derives from.
type Registry struct {
	cfg      Config
	provider provider.SpeechProvider
	events   Events
	logger   *slog.Logger
	sched    *scheduler

	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once

	mu     sync.Mutex
	runs   map[string]*Runner
	closed bool
}

// NewRegistry returns an empty registry with its shared scheduler running.
func NewRegistry(cfg Config, p provider.SpeechProvider, events Events, logger *slog.Logger) *Registry {
	if logger == nil {
		logger = slog.Default()
	}
	cfg = cfg.withDefaults()
	ctx, cancel := context.WithCancel(context.Background())
	return &Registry{
		cfg:      cfg,
		provider: p,
		events:   events,
		logger:   logger,
		sched:    newScheduler(ctx, cfg.MaxConcurrency),
		ctx:      ctx,
		cancel:   cancel,
		runs:     make(map[string]*Runner),
	}
}

// Start validates the request's source, spawns a Runner and registers it.
// Idempotent for the same runId (contract section 2): a repeated start with
// the current runId returns the existing runner. The run derives its context
// from the registry, not from ctx, so a caller's request scope cannot kill a
// live run.
func (r *Registry) Start(_ context.Context, sessionID string, req contract.SessionStartRequest) (*Runner, error) {
	r.mu.Lock()
	if active, ok := r.runs[sessionID]; ok {
		defer r.mu.Unlock()
		if active.RunID() == req.RunID {
			return active, nil
		}
		return nil, &AlreadyRunningError{RunID: active.RunID()}
	}
	r.mu.Unlock()

	if err := validateLanguages(req); err != nil {
		return nil, err
	}
	source, err := r.buildSource(req.Source)
	if err != nil {
		return nil, err
	}
	var runner *Runner
	runner = newRunner(r.ctx, sessionID, req, r.cfg, r.provider, r.events, source, r.sched, r.logger, func() {
		r.mu.Lock()
		if r.runs[sessionID] == runner {
			delete(r.runs, sessionID)
		}
		r.mu.Unlock()
		r.sched.remove(runner)
	})

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, ErrShuttingDown
	}
	if active, ok := r.runs[sessionID]; ok {
		return nil, &AlreadyRunningError{RunID: active.RunID()}
	}
	r.runs[sessionID] = runner
	r.sched.add(runner)
	go runner.run()
	return runner, nil
}

// validateLanguages rejects source and target languages outside the
// provider's table (docs/components/languages.md) before any source work.
func validateLanguages(req contract.SessionStartRequest) error {
	if _, err := provider.LanguageName(req.SourceLanguage); err != nil {
		return &UnsupportedLanguageError{Code: req.SourceLanguage}
	}
	for _, target := range req.TargetLanguages {
		if _, err := provider.LanguageName(target); err != nil {
			return &UnsupportedLanguageError{Code: target}
		}
	}
	return nil
}

// buildSource resolves the start request's producer. browser_mic has none:
// frames arrive over the ingest WebSocket. file_replay spawns ffmpeg through
// ingest.NewReplay; anything else is rejected.
func (r *Registry) buildSource(src contract.Source) (func(context.Context, ingest.Sink) error, error) {
	switch src.Type {
	case "browser_mic":
		return nil, nil
	case "file_replay":
		var cfg contract.FileReplayConfig
		if err := json.Unmarshal(src.Config, &cfg); err != nil {
			return nil, &InvalidSourceError{Type: "file_replay: " + err.Error()}
		}
		replay, err := ingest.NewReplay(r.cfg.FixturesDir, cfg)
		if err != nil {
			return nil, &InvalidSourceError{Type: err.Error()}
		}
		return replay.Run, nil
	default:
		return nil, &InvalidSourceError{Type: src.Type}
	}
}

// Stop asks the session's active run to wind down and returns its runID. An
// empty runID or the current one is accepted; a different one is
// not_running per contract.
func (r *Registry) Stop(sessionID, runID string) (string, error) {
	r.mu.Lock()
	runner, ok := r.runs[sessionID]
	r.mu.Unlock()
	if !ok || (runID != "" && runID != runner.RunID()) {
		return "", ErrNotRunning
	}
	runner.Stop()
	return runner.RunID(), nil
}

// Shutdown winds every active run down in parallel — each flushes its tail,
// drains its queue through the scheduler and ends idle — then stops the
// scheduler. For process teardown; safe to call more than once.
func (r *Registry) Shutdown() {
	r.once.Do(func() {
		r.mu.Lock()
		r.closed = true
		runners := make([]*Runner, 0, len(r.runs))
		for _, runner := range r.runs {
			runners = append(runners, runner)
		}
		r.mu.Unlock()
		for _, runner := range runners {
			runner.beginStop()
		}
		for _, runner := range runners {
			runner.waitDone()
		}
		r.cancel()
		r.sched.close()
	})
}

// Lookup implements ingest.Sessions.
func (r *Registry) Lookup(sessionID string) (ingest.Sink, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	runner, ok := r.runs[sessionID]
	if !ok {
		return nil, false
	}
	return runner, true
}

// Active reports the number of running sessions (for /healthz and
// GET /v1/sessions).
func (r *Registry) Active() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.runs)
}

// Sessions lists the active runs for GET /v1/sessions.
func (r *Registry) Sessions() []contract.RunningSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]contract.RunningSession, 0, len(r.runs))
	for sessionID, runner := range r.runs {
		out = append(out, contract.RunningSession{
			SessionID: sessionID,
			RunID:     runner.RunID(),
			Status:    runner.Status(),
			Stats:     runner.Stats(),
		})
	}
	return out
}
