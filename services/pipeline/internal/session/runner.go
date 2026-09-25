package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/ingest"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/provider"
)

// Runner owns one active run of a session: it turns producer frames into
// chunks, queues them for the shared scheduler, and emits contract events in
// chunk order. It implements ingest.Sink.
type Runner struct {
	sessionID string
	req       contract.SessionStartRequest
	cfg       Config
	provider  provider.SpeechProvider
	events    Events
	source    func(context.Context, ingest.Sink) error
	sched     *scheduler
	logger    *slog.Logger
	onDone    func()

	chunker *chunk.Chunker
	chunkMu sync.Mutex // serializes producer Push/Flush and the stop flush
	queue   chan chunk.Chunk
	results chan chunkResult
	runCtx  context.Context
	cancel  context.CancelFunc
	stopCh  chan struct{}
	done    chan struct{}
	stop    sync.Once

	outMu       sync.Mutex // guards outstanding, shared with the scheduler
	outstanding []int      // dispatched chunk indexes, sorted

	startedWall time.Time

	audioReceivedMs atomic.Int64
	chunksProcessed atomic.Int64
	chunksDropped   atomic.Int64
	lastPushUnix    atomic.Int64
	noAudioWarned   atomic.Bool
	status          atomic.Value // string
	glossary        atomic.Value // []contract.GlossaryTerm

	latMu     sync.Mutex
	latencies []int
	lastError atomic.Value // string
}

// newRunner builds a runner; runCtx derives from the registry's base context
// so a run's lifetime is bound to the pipeline, not to the caller of Start.
func newRunner(baseCtx context.Context, sessionID string, req contract.SessionStartRequest, cfg Config,
	p provider.SpeechProvider, events Events,
	source func(context.Context, ingest.Sink) error, sched *scheduler,
	logger *slog.Logger, onDone func()) *Runner {
	c := cfg.withDefaults()
	r := &Runner{
		sessionID:   sessionID,
		req:         req,
		cfg:         c,
		provider:    p,
		events:      events,
		source:      source,
		sched:       sched,
		logger:      logger.With("sessionId", sessionID, "runId", req.RunID),
		onDone:      onDone,
		chunker:     chunk.New(c.Chunk),
		queue:       make(chan chunk.Chunk, queueSize),
		results:     make(chan chunkResult, c.MaxConcurrency),
		stopCh:      make(chan struct{}),
		done:        make(chan struct{}),
		startedWall: c.Now(),
	}
	r.runCtx, r.cancel = context.WithCancel(baseCtx)
	r.status.Store("starting")
	r.glossary.Store(req.Glossary)
	return r
}

// RunID implements ingest.Sink.
func (r *Runner) RunID() string { return r.req.RunID }

// Status reports the current run status string (starting, running, stopping,
// idle, error).
func (r *Runner) Status() string { return r.status.Load().(string) }

// SetGlossary replaces the run's glossary so the next provider call — and
// therefore the next chunk — uses it (PUT /v1/sessions/{id}/glossary,
// contract section 2).
func (r *Runner) SetGlossary(terms []contract.GlossaryTerm) {
	r.glossary.Store(terms)
}

func (r *Runner) glossaryTerms() []contract.GlossaryTerm {
	return r.glossary.Load().([]contract.GlossaryTerm)
}

func (r *Runner) setStatus(status string) {
	r.status.Store(status)
	r.events.Status(r.sessionID, r.req.RunID, status, r.Stats())
}

// Push implements ingest.Sink: the frame feeds the chunker and any completed
// chunk enters the bounded queue, dropping the oldest on overflow.
func (r *Runner) Push(frame chunk.Frame) {
	if r.stopping() {
		return
	}
	r.lastPushUnix.Store(r.cfg.Now().Unix())
	r.noAudioWarned.Store(false)
	r.audioReceivedMs.Store(frame.StartMs + int64(len(frame.PCM))/32)
	r.chunkMu.Lock()
	ch, ok := r.chunker.Push(frame)
	r.chunkMu.Unlock()
	if ok {
		r.enqueue(ch)
	}
}

// Flush implements ingest.Sink: the buffered tail becomes a chunk when it
// meets the minimum length (ingest.md rule 4).
func (r *Runner) Flush() {
	if r.stopping() {
		return
	}
	r.chunkMu.Lock()
	ch, ok := r.chunker.Flush()
	r.chunkMu.Unlock()
	if ok {
		r.enqueue(ch)
	}
}

// QueueDepth implements ingest.Sink.
func (r *Runner) QueueDepth() int { return len(r.queue) }

// popQueued removes the oldest queued chunk and records its index as
// outstanding in one critical section, so the run loop's drain check never
// sees an empty queue while a chunk is in transit to a worker. Called only by
// the scheduler.
func (r *Runner) popQueued() (chunk.Chunk, bool) {
	r.outMu.Lock()
	defer r.outMu.Unlock()
	select {
	case ch := <-r.queue:
		r.outstanding = insertSorted(r.outstanding, ch.Index)
		return ch, true
	default:
		return chunk.Chunk{}, false
	}
}

// outstandingLen and minOutstanding read the dispatched-index list under its
// mutex for the run loop's emit and drain checks.
func (r *Runner) outstandingLen() int {
	r.outMu.Lock()
	defer r.outMu.Unlock()
	return len(r.outstanding)
}

func (r *Runner) minOutstanding() int {
	r.outMu.Lock()
	defer r.outMu.Unlock()
	if len(r.outstanding) == 0 {
		return -1
	}
	return r.outstanding[0]
}

func (r *Runner) stopping() bool {
	select {
	case <-r.stopCh:
		return true
	default:
		return false
	}
}

// enqueue adds a chunk to the bounded queue and wakes the scheduler. On
// overflow the oldest queued chunk is dropped with a chunk_dropped log event
// (ingest.md backpressure).
func (r *Runner) enqueue(ch chunk.Chunk) {
	select {
	case r.queue <- ch:
		r.sched.notify()
		return
	default:
	}
	select {
	case dropped := <-r.queue:
		r.chunksDropped.Add(1)
		r.events.LogForRun(r.sessionID, r.req.RunID, "warn", "chunk_dropped",
			fmt.Sprintf("queue full, dropped chunk %d", dropped.Index),
			json.RawMessage(fmt.Sprintf(`{"chunkIndex":%d}`, dropped.Index)))
	default:
	}
	r.queue <- ch
	r.sched.notify()
}

// beginStop asks the run to wind down without waiting; waitDone blocks until
// the dispatcher drained and closed done. Registry.Shutdown uses the pair to
// stop many sessions in parallel.
func (r *Runner) beginStop() {
	r.stop.Do(func() { close(r.stopCh) })
}

func (r *Runner) waitDone() { <-r.done }

// Stop winds the run down: the buffered audio flushes through the queue,
// workers drain, final segments emit, then a status event with idle closes
// the run (contract section 2). Safe to call more than once.
func (r *Runner) Stop() {
	r.beginStop()
	r.waitDone()
}

// run is the dispatcher goroutine owned by the runner. The shared scheduler
// pulls chunks from the queue and delivers provider results on r.results;
// this loop reorders them so segments emit in chunk order and beats the
// status heartbeat until stop is requested and the pipeline drains.
func (r *Runner) run() {
	defer close(r.done)
	defer r.cancel()
	defer r.onDone()

	if r.source != nil {
		go r.runSource(r.runCtx)
	}
	r.setStatus("running")

	pending := make(map[int]chunkResult) // finished results awaiting their turn

	heartbeat := time.NewTicker(r.cfg.StatusInterval)
	defer heartbeat.Stop()

	// stopWake lets a parked loop notice beginStop instead of sleeping until
	// the next result or heartbeat; once observed it is disabled so the drain
	// iterations below do not spin on the closed channel.
	stopWake := r.stopCh

	flushed := false
	for {
		if r.stopping() {
			if !flushed {
				// Stop flushes the buffered tail through the queue so its
				// final segments still emit (contract section 2).
				flushed = true
				r.chunkMu.Lock()
				if ch, ok := r.chunker.Flush(); ok {
					r.enqueue(ch)
				}
				r.chunkMu.Unlock()
			}
			if len(r.queue) == 0 && r.outstandingLen() == 0 && len(pending) == 0 {
				r.setStatus("idle")
				return
			}
		}
		select {
		case res := <-r.results:
			r.outMu.Lock()
			r.outstanding = removeIndex(r.outstanding, res.index)
			r.outMu.Unlock()
			pending[res.index] = res
			// Emit every pending result no longer overtaken by an earlier
			// chunk: anything still queued precedes everything dispatched so
			// far, and outstanding holds the earlier in-flight indexes.
			// Dropped chunks never reach outstanding, so backpressure cannot
			// wedge the ordering.
			for len(pending) > 0 && len(r.queue) == 0 {
				lowest := minPending(pending)
				if earlier := r.minOutstanding(); earlier >= 0 && earlier < lowest {
					break
				}
				r.emitResult(pending[lowest])
				delete(pending, lowest)
			}
		case <-heartbeat.C:
			r.checkNoAudio()
			r.events.Status(r.sessionID, r.req.RunID, r.Status(), r.Stats())
		case <-stopWake:
			stopWake = nil
		}
	}
}

// runSource owns the producer goroutine (ffmpeg for file_replay). An early
// exit is an ffmpeg_exit error that puts the run in error (ingest.md).
func (r *Runner) runSource(ctx context.Context) {
	err := r.source(ctx, r)
	if err == nil {
		return // cancelled by stop
	}
	var exited *ingest.ExitedError
	if errors.As(err, &exited) {
		r.fail("error", "ffmpeg_exit", exited.Error())
		return
	}
	r.fail("error", "ffmpeg_exit", fmt.Sprintf("source error: %v", err))
}

// fail logs an error-level event and flips the run status to error; the
// dispatcher keeps running so pending chunks can drain.
func (r *Runner) fail(level, code, message string) {
	r.events.LogForRun(r.sessionID, r.req.RunID, level, code, message, nil)
	r.lastError.Store(message)
	if level == "error" {
		r.setStatus("error")
	}
}

// checkNoAudio warns once per quiet spell when no frames arrive while the
// run is active (contract code no_audio).
func (r *Runner) checkNoAudio() {
	last := r.lastPushUnix.Load()
	if last == 0 || r.noAudioWarned.Load() {
		return
	}
	if r.cfg.Now().Unix()-last >= int64(r.cfg.NoAudioAfter.Seconds()) {
		r.noAudioWarned.Store(true)
		r.events.LogForRun(r.sessionID, r.req.RunID, "warn", "no_audio",
			"no frames for "+r.cfg.NoAudioAfter.String()+" on a running session", nil)
	}
}

// chunkResult is one provider pass over a chunk: the texts to emit and the
// log events raised along the way.
type chunkResult struct {
	index        int
	startMs      int64
	endMs        int64
	original     string
	translations map[string]string // language -> text
	logs         []logEntry
}

type logEntry struct {
	level   string
	code    string
	message string
}

// insertSorted keeps outstanding ascending; indexes are small and few.
func insertSorted(indexes []int, index int) []int {
	i := sort.SearchInts(indexes, index)
	indexes = append(indexes, 0)
	copy(indexes[i+1:], indexes[i:])
	indexes[i] = index
	return indexes
}

func removeIndex(indexes []int, index int) []int {
	if i := sort.SearchInts(indexes, index); i < len(indexes) && indexes[i] == index {
		return append(indexes[:i], indexes[i+1:]...)
	}
	return indexes
}

func minPending(pending map[int]chunkResult) int {
	lowest := -1
	for index := range pending {
		if lowest < 0 || index < lowest {
			lowest = index
		}
	}
	return lowest
}

// process runs one chunk through the provider honoring translationMode:
// "ast" takes one audio call for the first target (falling back to
// Transcribe+Translate on ok=false or unparseable output), "asr_then_text"
// transcribes once then translates per target. Provider failures produce log
// events instead of segments; the chunk is skipped.
func (r *Runner) process(ctx context.Context, ch chunk.Chunk) chunkResult {
	res := chunkResult{index: ch.Index, startMs: ch.StartMs, endMs: ch.EndMs}
	audio := provider.WAV{Data: ch.WAV(), Index: ch.Index, StartMs: int(ch.StartMs), EndMs: int(ch.EndMs)}
	source := r.req.SourceLanguage
	targets := r.req.TargetLanguages

	transcript, translations, logs := r.transcribe(ctx, audio, source, targets)
	res.logs = logs
	res.original = transcript
	res.translations = translations
	return res
}

func (r *Runner) transcribe(ctx context.Context, audio provider.WAV, source string, targets []string) (string, map[string]string, []logEntry) {
	var logs []logEntry
	translations := make(map[string]string)
	glossary := r.glossaryTerms()

	transcript, err := r.asr(ctx, audio, source, targets, &logs, translations)
	if err != nil {
		return "", nil, logs
	}
	for _, target := range targets {
		if _, done := translations[target]; done {
			continue
		}
		text, err := r.callTranslate(ctx, transcript, source, target)
		if err != nil {
			logs = append(logs, r.providerError(target, err))
			continue
		}
		translations[target] = text
	}
	if r.cfg.GlossaryEnforce {
		transcript = provider.EnforceGlossary(transcript, glossary, false)
		for target, text := range translations {
			translations[target] = provider.EnforceGlossary(text, glossary, true)
		}
	}
	return transcript, translations, logs
}

// asr obtains the transcript for the chunk. In ast mode it also fills the
// first target's translation when the provider's AST output parses; a parse
// failure logs provider_bad_output and falls back to Transcribe+Translate.
func (r *Runner) asr(ctx context.Context, audio provider.WAV, source string, targets []string, logs *[]logEntry, translations map[string]string) (string, error) {
	if r.req.TranslationMode == "ast" && len(targets) > 0 {
		ast, ok, err := r.provider.TranscribeAndTranslate(ctx, audio, provider.ASTRequest{
			SourceLanguage: source,
			TargetLanguage: targets[0],
			Glossary:       r.glossaryTerms(),
		})
		switch {
		case err == nil && ok:
			translations[targets[0]] = ast.Translation
			return ast.Transcript, nil
		case errors.Is(err, provider.ErrBadOutput):
			*logs = append(*logs, logEntry{"warn", "provider_bad_output", "AST output could not be parsed; falling back to Transcribe + Translate"})
		case err != nil:
			*logs = append(*logs, r.providerError(targets[0], err))
			return "", err
		}
		// ok == false: the backend cannot do AST; fall through to ASR.
	}
	out, err := r.provider.Transcribe(ctx, audio, provider.TranscribeRequest{
		SourceLanguage: source,
		Glossary:       r.glossaryTerms(),
	})
	if err != nil {
		*logs = append(*logs, r.providerError(source, err))
		return "", err
	}
	return string(out), nil
}

func (r *Runner) callTranslate(ctx context.Context, text, source, target string) (string, error) {
	return r.provider.Translate(ctx, text, provider.TranslateRequest{
		SourceLanguage: source,
		TargetLanguage: target,
		Glossary:       r.glossaryTerms(),
	})
}

// providerError maps provider failures onto contract log codes (section 6).
func (r *Runner) providerError(lang string, err error) logEntry {
	switch {
	case errors.Is(err, provider.ErrUnavailable):
		r.lastError.Store(err.Error())
		return logEntry{"error", "provider_unavailable", "all inference endpoints failing"}
	case errors.Is(err, context.DeadlineExceeded):
		return logEntry{"warn", "provider_timeout", fmt.Sprintf("request exceeded inference timeout for %s", lang)}
	default:
		return logEntry{"warn", "provider_error", fmt.Sprintf("chunk skipped: %v", err)}
	}
}

// emitResult emits a chunk's events in order: log entries, then the original
// segment, then one translation segment per target language. Latency is the
// wall-clock distance between the chunk's audio end and now.
func (r *Runner) emitResult(res chunkResult) {
	for _, entry := range res.logs {
		if entry.level == "error" {
			r.lastError.Store(entry.message)
		}
		r.events.LogForRun(r.sessionID, r.req.RunID, entry.level, entry.code, entry.message, nil)
	}
	r.chunksProcessed.Add(1)
	latencyMs := int(r.cfg.Now().Sub(r.startedWall).Milliseconds() - res.endMs)
	if latencyMs < 0 {
		latencyMs = 0
	}
	r.recordLatency(latencyMs)
	if res.original != "" {
		r.events.Segment(r.sessionID, r.req.RunID, contract.SegmentEvent{
			ChunkIndex: res.index,
			Kind:       "original",
			Language:   r.req.SourceLanguage,
			Text:       res.original,
			IsFinal:    true,
			StartMs:    int(res.startMs),
			EndMs:      int(res.endMs),
			LatencyMs:  latencyMs,
		})
	}
	for _, target := range r.req.TargetLanguages {
		text, ok := res.translations[target]
		if !ok || text == "" {
			continue
		}
		r.events.Segment(r.sessionID, r.req.RunID, contract.SegmentEvent{
			ChunkIndex: res.index,
			Kind:       "translation",
			Language:   target,
			Text:       text,
			IsFinal:    true,
			StartMs:    int(res.startMs),
			EndMs:      int(res.endMs),
			LatencyMs:  latencyMs,
		})
	}
}

func (r *Runner) recordLatency(ms int) {
	r.latMu.Lock()
	defer r.latMu.Unlock()
	r.latencies = append(r.latencies, ms)
	if len(r.latencies) > latencyWindow {
		r.latencies = r.latencies[len(r.latencies)-latencyWindow:]
	}
}

// Stats snapshots the contract SessionStats fields.
func (r *Runner) Stats() contract.SessionStats {
	stats := contract.SessionStats{
		AudioReceivedMs: int(r.audioReceivedMs.Load()),
		ChunksProcessed: int(r.chunksProcessed.Load()),
		ChunksDropped:   int(r.chunksDropped.Load()),
		QueueDepth:      len(r.queue),
	}
	if last := r.lastError.Load(); last != nil {
		msg := last.(string)
		stats.LastError = &msg
	}
	stats.LatencyP50Ms, stats.LatencyP95Ms = r.latencyPercentiles()
	return stats
}

func (r *Runner) latencyPercentiles() (p50, p95 int) {
	r.latMu.Lock()
	defer r.latMu.Unlock()
	if len(r.latencies) == 0 {
		return 0, 0
	}
	sorted := append([]int(nil), r.latencies...)
	sort.Ints(sorted)
	pick := func(q float64) int {
		i := int(q * float64(len(sorted)-1))
		return sorted[i]
	}
	return pick(0.50), pick(0.95)
}
