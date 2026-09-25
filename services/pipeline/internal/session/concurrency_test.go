package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/goleak"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/provider"
)

// Every registry must be shut down for the leak check to pass; the scheduler
// goroutine, runner dispatchers and provider workers are all accounted for.
func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}

// sessionEvents records Events calls split by sessionID so tests can assert
// per-session progress and isolation.
type sessionEvents struct {
	mu       sync.Mutex
	segments map[string][]contract.SegmentEvent
	statuses map[string][]contract.StatusEvent
	logs     map[string][]contract.LogEvent
}

func newSessionEvents() *sessionEvents {
	return &sessionEvents{
		segments: make(map[string][]contract.SegmentEvent),
		statuses: make(map[string][]contract.StatusEvent),
		logs:     make(map[string][]contract.LogEvent),
	}
}

func (e *sessionEvents) Segment(sessionID, _ string, ev contract.SegmentEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.segments[sessionID] = append(e.segments[sessionID], ev)
}

func (e *sessionEvents) Status(sessionID, _, status string, stats contract.SessionStats) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.statuses[sessionID] = append(e.statuses[sessionID], contract.StatusEvent{
		EventBase: contract.EventBase{Type: "status"},
		Status:    status,
		Stats:     stats,
	})
}

func (e *sessionEvents) Log(sessionID, level, code, message string) {
	e.LogForRun(sessionID, "", level, code, message, nil)
}

func (e *sessionEvents) LogForRun(sessionID, _, level, code, message string, _ json.RawMessage) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.logs[sessionID] = append(e.logs[sessionID], contract.LogEvent{
		EventBase: contract.EventBase{Type: "log"},
		Level:     level,
		Code:      code,
		Message:   message,
	})
}

func (e *sessionEvents) Flush(context.Context) {}

func (e *sessionEvents) segmentCount(sessionID string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.segments[sessionID])
}

func (e *sessionEvents) lastStatus(sessionID string) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	statuses := e.statuses[sessionID]
	if len(statuses) == 0 {
		return ""
	}
	return statuses[len(statuses)-1].Status
}

// trackingProvider wraps the mock and records the peak number of provider
// calls in flight, which the shared scheduler must keep within
// MaxConcurrency across all sessions combined.
type trackingProvider struct {
	inner   *provider.Mock
	current atomic.Int64
	peak    atomic.Int64
}

func (p *trackingProvider) enter() {
	n := p.current.Add(1)
	for peak := p.peak.Load(); n > peak && !p.peak.CompareAndSwap(peak, n); peak = p.peak.Load() {
	}
}

func (p *trackingProvider) leave() { p.current.Add(-1) }

func (p *trackingProvider) Transcribe(ctx context.Context, a provider.WAV, req provider.TranscribeRequest) (provider.Transcript, error) {
	p.enter()
	defer p.leave()
	return p.inner.Transcribe(ctx, a, req)
}

func (p *trackingProvider) TranscribeAndTranslate(ctx context.Context, a provider.WAV, req provider.ASTRequest) (provider.ASTResult, bool, error) {
	p.enter()
	defer p.leave()
	return p.inner.TranscribeAndTranslate(ctx, a, req)
}

func (p *trackingProvider) Translate(ctx context.Context, text string, req provider.TranslateRequest) (string, error) {
	p.enter()
	defer p.leave()
	return p.inner.Translate(ctx, text, req)
}

func (p *trackingProvider) Healthy() bool { return true }

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func startRequest(runID string) contract.SessionStartRequest {
	return contract.SessionStartRequest{
		ContractVersion: contract.Version,
		RunID:           runID,
		SourceLanguage:  "en",
		TargetLanguages: []string{"es"},
		TranslationMode: "ast",
		Source:          contract.Source{Type: "browser_mic", Config: json.RawMessage(`{}`)},
	}
}

// Four sessions on a shared budget of two: every session must keep
// progressing while in-flight provider calls never exceed the shared cap.
func TestConcurrentSessionsShareProviderCapacity(t *testing.T) {
	p := &trackingProvider{inner: provider.NewMock(150*time.Millisecond, nil)}
	events := newSessionEvents()
	cfg := testConfig()
	cfg.MaxConcurrency = 2
	reg := NewRegistry(cfg, p, events, discardLogger())
	t.Cleanup(reg.Shutdown)

	const sessionCount, blocks = 4, 4
	for i := 0; i < sessionCount; i++ {
		sessionID := fmt.Sprintf("sess-%d", i)
		if _, err := reg.Start(context.Background(), sessionID, startRequest(fmt.Sprintf("run-%d", i))); err != nil {
			t.Fatalf("start %s: %v", sessionID, err)
		}
	}
	for i := 0; i < sessionCount; i++ {
		sessionID := fmt.Sprintf("sess-%d", i)
		sink, ok := reg.Lookup(sessionID)
		if !ok {
			t.Fatalf("session %s not running", sessionID)
		}
		feed(t, sink, speechBlocks(blocks, 1200, 400))
	}

	// ast mode emits one original plus one translation segment per chunk.
	for i := 0; i < sessionCount; i++ {
		sessionID := fmt.Sprintf("sess-%d", i)
		waitFor(t, sessionID+" segments", func() bool {
			return events.segmentCount(sessionID) >= 2*blocks
		})
	}
	if peak := p.peak.Load(); peak != int64(cfg.MaxConcurrency) {
		t.Fatalf("provider calls in flight peaked at %d, want exactly %d (shared capacity across sessions)", peak, cfg.MaxConcurrency)
	}
}

// Each session's stats reflect only its own audio: different feeds produce
// different counts with nothing shared or dropped.
func TestSessionStatsIndependent(t *testing.T) {
	p := &trackingProvider{inner: provider.NewMock(30*time.Millisecond, nil)}
	events := newSessionEvents()
	cfg := testConfig()
	cfg.MaxConcurrency = 2
	reg := NewRegistry(cfg, p, events, discardLogger())
	t.Cleanup(reg.Shutdown)

	blocks := []int{1, 2, 3, 4}
	want := make(map[string]int, len(blocks))
	for i, n := range blocks {
		sessionID := fmt.Sprintf("sess-%d", i)
		want[sessionID] = n
		if _, err := reg.Start(context.Background(), sessionID, startRequest(fmt.Sprintf("run-%d", i))); err != nil {
			t.Fatalf("start %s: %v", sessionID, err)
		}
		sink, ok := reg.Lookup(sessionID)
		if !ok {
			t.Fatalf("session %s not running", sessionID)
		}
		feed(t, sink, speechBlocks(n, 1200, 400))
	}
	for sessionID, n := range want {
		waitFor(t, sessionID+" segments", func() bool {
			return events.segmentCount(sessionID) >= 2*n
		})
	}

	running := make(map[string]contract.RunningSession)
	for _, rs := range reg.Sessions() {
		running[rs.SessionID] = rs
	}
	for sessionID, n := range want {
		rs, ok := running[sessionID]
		if !ok {
			t.Fatalf("%s missing from Sessions()", sessionID)
		}
		if rs.Stats.ChunksProcessed != n {
			t.Fatalf("%s chunks processed = %d, want %d", sessionID, rs.Stats.ChunksProcessed, n)
		}
		if rs.Stats.ChunksDropped != 0 {
			t.Fatalf("%s chunks dropped = %d, want 0", sessionID, rs.Stats.ChunksDropped)
		}
		if wantAudio := n * 1600; rs.Stats.AudioReceivedMs != wantAudio {
			t.Fatalf("%s audio received = %d ms, want %d ms", sessionID, rs.Stats.AudioReceivedMs, wantAudio)
		}
	}
}

// Shutdown drains every run in parallel: buffered tails flush, final
// segments emit, every session ends idle and nothing stays registered.
func TestShutdownStopsAllSessions(t *testing.T) {
	p := &trackingProvider{inner: provider.NewMock(30*time.Millisecond, nil)}
	events := newSessionEvents()
	reg := NewRegistry(testConfig(), p, events, discardLogger())

	const sessionCount = 4
	for i := 0; i < sessionCount; i++ {
		sessionID := fmt.Sprintf("sess-%d", i)
		if _, err := reg.Start(context.Background(), sessionID, startRequest(fmt.Sprintf("run-%d", i))); err != nil {
			t.Fatalf("start %s: %v", sessionID, err)
		}
		sink, ok := reg.Lookup(sessionID)
		if !ok {
			t.Fatalf("session %s not running", sessionID)
		}
		// Speech with no trailing silence: only the shutdown flush can emit it.
		feed(t, sink, tonePCM(1200, 0.5))
	}

	reg.Shutdown()

	for i := 0; i < sessionCount; i++ {
		sessionID := fmt.Sprintf("sess-%d", i)
		if got := events.lastStatus(sessionID); got != "idle" {
			t.Fatalf("%s last status = %q, want idle", sessionID, got)
		}
		if events.segmentCount(sessionID) == 0 {
			t.Fatalf("%s emitted no segments; shutdown did not flush the tail", sessionID)
		}
		if _, ok := reg.Lookup(sessionID); ok {
			t.Fatalf("%s still resolves after shutdown", sessionID)
		}
	}
	if active := reg.Active(); active != 0 {
		t.Fatalf("active runs after shutdown = %d, want 0", active)
	}
	if _, err := reg.Start(context.Background(), "sess-late", startRequest("run-late")); !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("start after shutdown error = %v, want ErrShuttingDown", err)
	}
}
