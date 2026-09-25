// Package emit batches session events and posts them to the web app's
// internal events endpoint (contract section 3): a flush every
// EVENTS_FLUSH_MS or when 50 events accumulate, exponential backoff up to
// 30 s on failure, and at most 5000 buffered events per session, dropping the
// oldest with an events_dropped log event.
package emit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

const (
	// batchMax is the contract's per-POST event cap.
	batchMax = 50
	// bufferMax bounds buffered events per session while the web app is down.
	bufferMax = 5000
	// backoffMax caps the retry delay for a failed batch.
	backoffMax = 30 * time.Second
)

// Config tunes the client; zero values fall back to the contract defaults.
type Config struct {
	WebURL       string        // base URL of the web app (WEB_URL)
	SharedSecret string        // bearer token for the events endpoint
	Flush        time.Duration // batching interval (EVENTS_FLUSH_MS)
	BufferMax    int           // per-session buffered event cap
	// Now supplies emittedAt timestamps; time.Now when nil.
	Now func() time.Time
}

// Client owns per-session event buffers and a flusher goroutine. It also
// implements ingest.Events so producers can raise log events. Safe for
// concurrent use.
type Client struct {
	cfg    Config
	http   *http.Client
	logger *slog.Logger
	now    func() time.Time

	mu     sync.Mutex
	queues map[string][]contract.Event // sessionID -> pending events, oldest first
	wake   chan struct{}               // signals the flusher that a batch is full
	done   chan struct{}
	cancel context.CancelFunc
}

// NewClient starts the flusher goroutine. Close stops it.
func NewClient(cfg Config, logger *slog.Logger) *Client {
	if cfg.Flush <= 0 {
		cfg.Flush = 250 * time.Millisecond
	}
	if cfg.BufferMax <= 0 {
		cfg.BufferMax = bufferMax
	}
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		cfg:    cfg,
		http:   &http.Client{Timeout: 10 * time.Second},
		logger: logger,
		now:    cfg.Now,
		queues: make(map[string][]contract.Event),
		wake:   make(chan struct{}, 1),
		done:   make(chan struct{}),
		cancel: cancel,
	}
	go c.flushLoop(ctx)
	return c
}

func (c *Client) emittedAt() string {
	return c.now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// Segment enqueues a segment event (contract section 3).
func (c *Client) Segment(sessionID, runID string, ev contract.SegmentEvent) {
	ev.Type = "segment"
	ev.SessionID = sessionID
	ev.RunID = runID
	ev.EmittedAt = c.emittedAt()
	c.enqueue(sessionID, contract.Event{Segment: &ev})
}

// Status enqueues a status event with the given state and stats snapshot.
func (c *Client) Status(sessionID, runID, status string, stats contract.SessionStats) {
	c.enqueue(sessionID, contract.Event{Status: &contract.StatusEvent{
		EventBase: contract.EventBase{
			Type:      "status",
			SessionID: sessionID,
			RunID:     runID,
			EmittedAt: c.emittedAt(),
		},
		Status: status,
		Stats:  stats,
	}})
}

// Log enqueues a log event; it satisfies ingest.Events.
func (c *Client) Log(sessionID, level, code, message string) {
	c.LogForRun(sessionID, "", level, code, message, nil)
}

// LogForRun enqueues a log event stamped with the run id and optional data.
func (c *Client) LogForRun(sessionID, runID, level, code, message string, data json.RawMessage) {
	c.enqueue(sessionID, contract.Event{Log: &contract.LogEvent{
		EventBase: contract.EventBase{
			Type:      "log",
			SessionID: sessionID,
			RunID:     runID,
			EmittedAt: c.emittedAt(),
		},
		Level:   level,
		Code:    code,
		Message: message,
		Data:    data,
	}})
}

// enqueue appends ev to the session's buffer, dropping the oldest events when
// the cap is exceeded and reporting each overflow once per drop batch as an
// events_dropped log event.
func (c *Client) enqueue(sessionID string, ev contract.Event) {
	c.mu.Lock()
	queue := c.queues[sessionID]
	dropped := 0
	for len(queue) >= c.cfg.BufferMax {
		queue = queue[1:]
		dropped++
	}
	if dropped > 0 {
		if len(queue) >= c.cfg.BufferMax-1 {
			queue = queue[1:] // make room for the drop notice itself
			dropped++
		}
		queue = append(queue, c.dropNotice(sessionID, dropped))
	}
	c.queues[sessionID] = append(queue, ev)
	c.mu.Unlock()
	if dropped > 0 {
		c.logger.Error("event buffer overflow, dropped oldest events",
			"sessionId", sessionID, "dropped", dropped)
	}
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// dropNotice builds the events_dropped log event recorded for an overflow.
func (c *Client) dropNotice(sessionID string, dropped int) contract.Event {
	data, _ := json.Marshal(map[string]int{"dropped": dropped})
	return contract.Event{Log: &contract.LogEvent{
		EventBase: contract.EventBase{
			Type:      "log",
			SessionID: sessionID,
			EmittedAt: c.emittedAt(),
		},
		Level:   "error",
		Code:    "events_dropped",
		Message: fmt.Sprintf("event buffer overflow, dropped %d oldest events", dropped),
		Data:    data,
	}}
}

func (c *Client) pendingCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	total := 0
	for _, queue := range c.queues {
		total += len(queue)
	}
	return total
}

// take pops up to n events across sessions, oldest per session first; sessions
// contribute in a round-robin pass so one chatty session cannot starve others.
func (c *Client) take(n int) []contract.Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	var batch []contract.Event
	for len(batch) < n {
		progress := false
		for sessionID, queue := range c.queues {
			if len(batch) >= n {
				break
			}
			if len(queue) == 0 {
				continue
			}
			batch = append(batch, queue[0])
			c.queues[sessionID] = queue[1:]
			progress = true
		}
		if !progress {
			break
		}
	}
	return batch
}

// flushLoop posts a batch every Flush interval while events are pending, or
// immediately once batchMax events accumulated.
func (c *Client) flushLoop(ctx context.Context) {
	defer close(c.done)
	ticker := time.NewTicker(c.cfg.Flush)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-c.wake:
		}
		c.drain(ctx)
	}
}

// drain posts pending events in batches of at most batchMax. A failed batch
// is pushed back to the front of its sessions' queues and retried with
// exponential backoff capped at backoffMax.
func (c *Client) drain(ctx context.Context) {
	backoff := c.cfg.Flush
	for {
		batch := c.take(batchMax)
		if len(batch) == 0 {
			return
		}
		if err := c.post(ctx, batch); err != nil {
			c.restore(batch)
			c.logger.Warn("events batch failed, will retry",
				"events", len(batch), "backoff", backoff, "error", err)
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			backoff *= 2
			if backoff > backoffMax {
				backoff = backoffMax
			}
			continue
		}
		backoff = c.cfg.Flush
	}
}

// restore returns a failed batch to the front of each event's session queue
// so ordering per session is preserved.
func (c *Client) restore(batch []contract.Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	front := make(map[string][]contract.Event)
	for _, ev := range batch {
		sessionID := eventSession(ev)
		front[sessionID] = append(front[sessionID], ev)
	}
	for sessionID, events := range front {
		queue := append(events, c.queues[sessionID]...)
		if len(queue) > c.cfg.BufferMax {
			queue = queue[len(queue)-c.cfg.BufferMax:]
		}
		c.queues[sessionID] = queue
	}
}

func eventSession(ev contract.Event) string {
	switch {
	case ev.Segment != nil:
		return ev.Segment.SessionID
	case ev.Status != nil:
		return ev.Status.SessionID
	case ev.Log != nil:
		return ev.Log.SessionID
	}
	return ""
}

// post sends one batch to the events endpoint.
func (c *Client) post(ctx context.Context, batch []contract.Event) error {
	body, err := json.Marshal(contract.EventBatch{
		ContractVersion: contract.Version,
		Events:          batch,
	})
	if err != nil {
		return fmt.Errorf("marshal batch: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.cfg.WebURL+"/api/internal/events", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.cfg.SharedSecret)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("events endpoint answered %d", resp.StatusCode)
	}
	return nil
}

// Flush forces one drain pass, used at session stop and shutdown so final
// events (notably status: idle) leave promptly. It returns once the current
// queues are empty or ctx is done.
func (c *Client) Flush(ctx context.Context) {
	for {
		if c.pendingCount() == 0 {
			return
		}
		c.drain(ctx)
		if c.pendingCount() == 0 || ctx.Err() != nil {
			return
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

// Close stops the flusher goroutine. Buffered events are left in memory;
// callers wanting a final send should Flush first.
func (c *Client) Close() {
	c.cancel()
	<-c.done
}
