package session

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/ingest"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/provider"
)

// captured records every event the runner emits, in arrival order.
type captured struct {
	mu       sync.Mutex
	segments []contract.SegmentEvent
	statuses []contract.StatusEvent
	logs     []contract.LogEvent
}

func (c *captured) Segment(_, _ string, ev contract.SegmentEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.segments = append(c.segments, ev)
}

func (c *captured) Status(_, _, status string, stats contract.SessionStats) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.statuses = append(c.statuses, contract.StatusEvent{
		EventBase: contract.EventBase{Type: "status"},
		Status:    status,
		Stats:     stats,
	})
}

func (c *captured) Log(sessionID, level, code, message string) {
	c.LogForRun(sessionID, "", level, code, message, nil)
}

func (c *captured) LogForRun(_, _, level, code, message string, _ json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.logs = append(c.logs, contract.LogEvent{
		EventBase: contract.EventBase{Type: "log"},
		Level:     level,
		Code:      code,
		Message:   message,
	})
}

func (c *captured) Flush(context.Context) {}

func (c *captured) segmentCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.segments)
}

func (c *captured) hasLog(code string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, l := range c.logs {
		if l.Code == code {
			return true
		}
	}
	return false
}

func (c *captured) lastStatus() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.statuses) == 0 {
		return ""
	}
	return c.statuses[len(c.statuses)-1].Status
}

// testProvider wraps the mock with knobs the tests need.
type testProvider struct {
	inner   *provider.Mock
	astErr  error
	delay   time.Duration
	callCnt chan struct{}

	glossMu    sync.Mutex
	glossaries [][]contract.GlossaryTerm // glossary seen by each call, in order
}

func (p *testProvider) Transcribe(ctx context.Context, a provider.WAV, req provider.TranscribeRequest) (provider.Transcript, error) {
	p.note(req.Glossary)
	p.track(ctx)
	return p.inner.Transcribe(ctx, a, req)
}

func (p *testProvider) TranscribeAndTranslate(ctx context.Context, a provider.WAV, req provider.ASTRequest) (provider.ASTResult, bool, error) {
	p.note(req.Glossary)
	p.track(ctx)
	if p.astErr != nil {
		return provider.ASTResult{}, false, p.astErr
	}
	return p.inner.TranscribeAndTranslate(ctx, a, req)
}

func (p *testProvider) Translate(ctx context.Context, text string, req provider.TranslateRequest) (string, error) {
	p.note(req.Glossary)
	p.track(ctx)
	return p.inner.Translate(ctx, text, req)
}

func (p *testProvider) note(glossary []contract.GlossaryTerm) {
	p.glossMu.Lock()
	defer p.glossMu.Unlock()
	p.glossaries = append(p.glossaries, glossary)
}

func (p *testProvider) Healthy() bool { return true }

func (p *testProvider) track(ctx context.Context) {
	if p.callCnt != nil {
		select {
		case p.callCnt <- struct{}{}:
		default:
		}
	}
	if p.delay > 0 {
		t := time.NewTimer(p.delay)
		defer t.Stop()
		select {
		case <-ctx.Done():
		case <-t.C:
		}
	}
}

func testConfig() Config {
	return Config{
		Chunk:          chunk.Config{Min: 400 * time.Millisecond, Target: 800 * time.Millisecond, Max: 3 * time.Second},
		MaxConcurrency: 1,
		StatusInterval: 60 * time.Millisecond,
		NoAudioAfter:   time.Second,
	}
}

func startRunner(t *testing.T, p provider.SpeechProvider, mode string) (*Registry, *Runner, *captured) {
	t.Helper()
	events := &captured{}
	reg := NewRegistry(testConfig(), p, events, slog.New(slog.NewTextHandler(io.Discard, nil)))
	req := contract.SessionStartRequest{
		ContractVersion: contract.Version,
		RunID:           "run-1",
		SourceLanguage:  "en",
		TargetLanguages: []string{"es"},
		TranslationMode: mode,
		Source:          contract.Source{Type: "browser_mic", Config: json.RawMessage(`{}`)},
	}
	runner, err := reg.Start(context.Background(), "sess-1", req)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(runner.Stop)
	t.Cleanup(reg.Shutdown)
	return reg, runner, events
}

// feed pushes raw PCM through the sink in 200 ms frames stamped by an audio
// clock, mirroring a real producer.
func feed(t *testing.T, sink interface {
	Push(chunk.Frame)
}, pcm []byte) {
	t.Helper()
	var clock chunk.Clock
	const frameBytes = 6400
	for len(pcm) > 0 {
		n := min(frameBytes, len(pcm))
		sink.Push(clock.NextFrame(pcm[:n]))
		pcm = pcm[n:]
	}
}

func tonePCM(ms int, amplitude float64) []byte {
	pcm := make([]byte, ms*32)
	for i := 0; i < len(pcm)/2; i++ {
		sample := int16(amplitude * math.Sin(2*math.Pi*440*float64(i)/16000) * 32767)
		binary.LittleEndian.PutUint16(pcm[i*2:], uint16(sample))
	}
	return pcm
}

func silencePCM(ms int) []byte { return make([]byte, ms*32) }

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// speechBlocks alternates tone and silence so each block becomes one chunk.
func speechBlocks(n, toneMs, gapMs int) []byte {
	var parts [][]byte
	for i := 0; i < n; i++ {
		parts = append(parts, tonePCM(toneMs, 0.5), silencePCM(gapMs))
	}
	return concat(parts...)
}

func TestSegmentsInOrderWithTimestamps(t *testing.T) {
	reg, runner, events := startRunner(t, &testProvider{inner: provider.NewMock(0, nil)}, "ast")
	sink, ok := reg.Lookup("sess-1")
	if !ok {
		t.Fatal("session not running")
	}

	// Three speech blocks -> three chunks; silence tails make the cuts.
	feed(t, sink, speechBlocks(3, 1200, 400))
	waitFor(t, "6 segments", func() bool { return events.segmentCount() >= 6 })
	runner.Stop()

	events.mu.Lock()
	defer events.mu.Unlock()
	for i := 0; i < 3; i++ {
		orig := events.segments[i*2]
		tr := events.segments[i*2+1]
		if orig.ChunkIndex != i || orig.Kind != "original" || orig.Language != "en" {
			t.Fatalf("segment %d unexpected: %+v", i*2, orig)
		}
		if tr.ChunkIndex != i || tr.Kind != "translation" || tr.Language != "es" {
			t.Fatalf("segment %d unexpected: %+v", i*2+1, tr)
		}
		// The mock attributes chunks to speakers in pairs: S1, S1, S2, ...
		wantSpeaker := []string{"S1", "S1", "S2"}[i]
		if orig.Speaker == nil || *orig.Speaker != wantSpeaker {
			t.Fatalf("chunk %d original speaker = %v, want %q", i, orig.Speaker, wantSpeaker)
		}
		if tr.Speaker == nil || *tr.Speaker != *orig.Speaker {
			t.Fatalf("chunk %d translation speaker = %v, want %v", i, tr.Speaker, *orig.Speaker)
		}
		if orig.StartMs != tr.StartMs || orig.EndMs != tr.EndMs {
			t.Fatalf("translation timestamps differ from original: %+v vs %+v", tr, orig)
		}
		if orig.EndMs <= orig.StartMs {
			t.Fatalf("bad timestamps %+v", orig)
		}
	}
	// Chunks are contiguous in audio time.
	first, second := events.segments[0], events.segments[2]
	if second.StartMs < first.EndMs {
		t.Fatalf("chunk 1 starts before chunk 0 ends: %+v / %+v", first, second)
	}
}

func TestChunkDroppedOnFullQueue(t *testing.T) {
	p := &testProvider{inner: provider.NewMock(0, nil), delay: 120 * time.Millisecond}
	reg, runner, events := startRunner(t, p, "asr_then_text")
	sink, ok := reg.Lookup("sess-1")
	if !ok {
		t.Fatal("session not running")
	}

	// Produce more chunks than queueSize+workers can absorb quickly.
	feed(t, sink, speechBlocks(10, 1200, 400))
	waitFor(t, "chunks dropped or all processed", func() bool {
		return events.hasLog("chunk_dropped") || runner.Stats().ChunksProcessed >= 10
	})
	runner.Stop()

	stats := runner.Stats()
	if stats.ChunksDropped == 0 {
		t.Fatal("expected dropped chunks under backpressure")
	}
	if !events.hasLog("chunk_dropped") {
		t.Fatal("expected a chunk_dropped log event")
	}
}

func TestStatusHeartbeat(t *testing.T) {
	reg, runner, events := startRunner(t, &testProvider{inner: provider.NewMock(0, nil)}, "ast")
	sink, ok := reg.Lookup("sess-1")
	if !ok {
		t.Fatal("session not running")
	}

	feed(t, sink, speechBlocks(1, 1200, 400))
	// With a 60 ms heartbeat the run must emit several status events quickly.
	time.Sleep(200 * time.Millisecond)
	events.mu.Lock()
	count := len(events.statuses)
	events.mu.Unlock()
	if count < 3 {
		t.Fatalf("expected repeated status events, got %d", count)
	}
	runner.Stop()
	if events.lastStatus() != "idle" {
		t.Fatalf("final status = %q, want idle", events.lastStatus())
	}
}

// fallbackProvider fails AST with ErrBadOutput; the runner must log
// provider_bad_output and still emit the translation via Translate.
type fallbackProvider struct{ inner *provider.Mock }

func (f *fallbackProvider) Transcribe(ctx context.Context, a provider.WAV, req provider.TranscribeRequest) (provider.Transcript, error) {
	return f.inner.Transcribe(ctx, a, req)
}
func (f *fallbackProvider) TranscribeAndTranslate(context.Context, provider.WAV, provider.ASTRequest) (provider.ASTResult, bool, error) {
	return provider.ASTResult{}, false, provider.ErrBadOutput
}
func (f *fallbackProvider) Translate(ctx context.Context, text string, req provider.TranslateRequest) (string, error) {
	return f.inner.Translate(ctx, text, req)
}
func (f *fallbackProvider) Healthy() bool { return true }

func TestASTFallbackLogsBadOutput(t *testing.T) {
	reg, runner, events := startRunner(t, &fallbackProvider{inner: provider.NewMock(0, nil)}, "ast")
	sink, ok := reg.Lookup("sess-1")
	if !ok {
		t.Fatal("session not running")
	}

	feed(t, sink, speechBlocks(1, 1200, 400))
	waitFor(t, "2 segments", func() bool { return events.segmentCount() >= 2 })
	runner.Stop()

	if !events.hasLog("provider_bad_output") {
		t.Fatal("expected provider_bad_output log event")
	}
	events.mu.Lock()
	defer events.mu.Unlock()
	if events.segments[1].Kind != "translation" {
		t.Fatalf("expected fallback translation, got %+v", events.segments[1])
	}
}

func TestGlossaryUpdateAppliesToNextChunk(t *testing.T) {
	p := &testProvider{inner: provider.NewMock(0, nil)}
	reg, runner, events := startRunner(t, p, "ast")
	sink, ok := reg.Lookup("sess-1")
	if !ok {
		t.Fatal("session not running")
	}

	feed(t, sink, speechBlocks(1, 1200, 400))
	waitFor(t, "first chunk segments", func() bool { return events.segmentCount() >= 2 })

	if _, err := reg.UpdateGlossary("sess-1", []contract.GlossaryTerm{{Term: "Nerdearla"}}); err != nil {
		t.Fatalf("update glossary: %v", err)
	}

	feed(t, sink, speechBlocks(1, 1200, 400))
	waitFor(t, "second chunk segments", func() bool { return events.segmentCount() >= 4 })
	runner.Stop()

	p.glossMu.Lock()
	defer p.glossMu.Unlock()
	if len(p.glossaries) < 2 {
		t.Fatalf("expected at least 2 provider calls, got %d", len(p.glossaries))
	}
	if len(p.glossaries[0]) != 0 {
		t.Fatalf("first call glossary = %+v, want empty", p.glossaries[0])
	}
	if got := p.glossaries[1]; len(got) != 1 || got[0].Term != "Nerdearla" {
		t.Fatalf("second call glossary = %+v, want [Nerdearla]", got)
	}
}

func TestStopFlushesTailAndEndsIdle(t *testing.T) {
	reg, runner, events := startRunner(t, &testProvider{inner: provider.NewMock(0, nil)}, "ast")
	sink, ok := reg.Lookup("sess-1")
	if !ok {
		t.Fatal("session not running")
	}

	// One block of speech with no trailing silence: only Stop's flush can emit it.
	feed(t, sink, tonePCM(1200, 0.5))
	runner.Stop()

	events.mu.Lock()
	defer events.mu.Unlock()
	if len(events.segments) == 0 {
		t.Fatal("stop did not flush the buffered chunk")
	}
	last := events.statuses[len(events.statuses)-1]
	if last.Status != "idle" {
		t.Fatalf("final status = %q, want idle", last.Status)
	}
}

// startRunnerWithSource builds a runner through the registry path but with an
// explicit source function, so tests can exercise runSource without ffmpeg.
func startRunnerWithSource(t *testing.T, p provider.SpeechProvider, source func(context.Context, ingest.Sink) error) (*Runner, *captured) {
	t.Helper()
	events := &captured{}
	reg := NewRegistry(testConfig(), p, events, slog.New(slog.NewTextHandler(io.Discard, nil)))
	req := contract.SessionStartRequest{
		ContractVersion: contract.Version,
		RunID:           "run-src",
		SourceLanguage:  "en",
		TargetLanguages: []string{"es"},
		TranslationMode: "ast",
		Source:          contract.Source{Type: "browser_mic", Config: json.RawMessage(`{}`)},
	}
	var runner *Runner
	runner = newRunner(reg.ctx, "sess-src", req, reg.cfg, reg.provider, events, source, reg.sched, reg.logger, func() {
		reg.sched.remove(runner)
	})
	reg.sched.add(runner)
	go runner.run()
	t.Cleanup(runner.Stop)
	t.Cleanup(reg.Shutdown)
	return runner, events
}

// A clean producer exit (a non-looping replay reaching EOF) flushes the
// buffered tail and drains to idle like a stop request, logging ffmpeg_exit
// at info level rather than erroring the session.
func TestCleanSourceExitDrainsToIdle(t *testing.T) {
	source := func(_ context.Context, sink ingest.Sink) error {
		feed(t, sink, tonePCM(1200, 0.5))
		return &ingest.ExitedError{ExitCode: 0}
	}
	_, events := startRunnerWithSource(t, &testProvider{inner: provider.NewMock(0, nil)}, source)

	waitFor(t, "run to drain to idle", func() bool { return events.lastStatus() == "idle" })
	if events.segmentCount() == 0 {
		t.Fatal("clean exit did not flush the buffered chunk")
	}
	if !events.hasLog("ffmpeg_exit") {
		t.Fatal("expected an ffmpeg_exit log event")
	}
	events.mu.Lock()
	defer events.mu.Unlock()
	for _, status := range events.statuses {
		if status.Status == "error" {
			t.Fatal("clean exit put the run in error")
		}
	}
	for _, l := range events.logs {
		if l.Code == "ffmpeg_exit" && l.Level != "info" {
			t.Fatalf("ffmpeg_exit level = %q, want info", l.Level)
		}
	}
}

// A non-zero producer exit stays an ffmpeg_exit error.
func TestFailedSourceExitEndsError(t *testing.T) {
	source := func(context.Context, ingest.Sink) error {
		return &ingest.ExitedError{ExitCode: 1, Stderr: "boom"}
	}
	_, events := startRunnerWithSource(t, &testProvider{inner: provider.NewMock(0, nil)}, source)

	waitFor(t, "error status", func() bool { return events.lastStatus() == "error" })
	events.mu.Lock()
	defer events.mu.Unlock()
	found := false
	for _, l := range events.logs {
		if l.Code == "ffmpeg_exit" && l.Level == "error" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected an error-level ffmpeg_exit log event")
	}
}
