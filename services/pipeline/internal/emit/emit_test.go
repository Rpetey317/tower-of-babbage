package emit

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

// receiver collects event batches through the contract endpoint shape.
type receiver struct {
	mu      sync.Mutex
	batches []contract.EventBatch
	fail    atomic.Int32 // remaining failures before accepting
}

func (r *receiver) handler(w http.ResponseWriter, req *http.Request) {
	if req.Header.Get("Authorization") != "Bearer test-secret" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	body, _ := io.ReadAll(req.Body)
	var batch contract.EventBatch
	if err := json.Unmarshal(body, &batch); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if r.fail.Add(-1) >= 0 {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	r.mu.Lock()
	r.batches = append(r.batches, batch)
	r.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(contract.EventBatchResponse{Accepted: len(batch.Events)})
}

func (r *receiver) events() []contract.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	var events []contract.Event
	for _, batch := range r.batches {
		events = append(events, batch.Events...)
	}
	return events
}

func (r *receiver) count() int { return len(r.events()) }

func newTestClient(t *testing.T, srv *httptest.Server, cfg Config) *Client {
	t.Helper()
	cfg.WebURL = srv.URL
	cfg.SharedSecret = "test-secret"
	if cfg.Flush == 0 {
		cfg.Flush = 10 * time.Millisecond
	}
	client := NewClient(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(client.Close)
	return client
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

func TestRetryAfterFailures(t *testing.T) {
	rec := &receiver{}
	rec.fail.Store(2) // two failed posts, then accept
	srv := httptest.NewServer(http.HandlerFunc(rec.handler))
	t.Cleanup(srv.Close)
	client := newTestClient(t, srv, Config{})

	client.LogForRun("s1", "r1", "info", "hello", "world", nil)
	waitFor(t, "event delivery", func() bool { return rec.count() == 1 })
	events := rec.events()
	if events[0].Log == nil || events[0].Log.Message != "world" || events[0].Log.RunID != "r1" {
		t.Fatalf("unexpected event: %+v", events[0])
	}
}

func TestBatchSplitsAtFifty(t *testing.T) {
	rec := &receiver{}
	srv := httptest.NewServer(http.HandlerFunc(rec.handler))
	t.Cleanup(srv.Close)
	client := newTestClient(t, srv, Config{})

	for i := 0; i < 120; i++ {
		client.Log("s1", "info", "x", "m")
	}
	waitFor(t, "all events", func() bool { return rec.count() == 120 })
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, batch := range rec.batches {
		if len(batch.Events) > batchMax {
			t.Fatalf("batch exceeds cap: %d", len(batch.Events))
		}
		if batch.ContractVersion != contract.Version {
			t.Fatalf("wrong contract version: %d", batch.ContractVersion)
		}
	}
}

func TestBufferCapDropsOldest(t *testing.T) {
	rec := &receiver{}
	srv := httptest.NewServer(http.HandlerFunc(rec.handler))
	srv.Close() // endpoint unreachable: everything buffers
	client := NewClient(Config{
		WebURL:       srv.URL,
		SharedSecret: "s",
		Flush:        time.Hour, // no periodic flush during the test
		BufferMax:    5,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer client.Close()

	for i := 0; i < 8; i++ {
		client.Log("s1", "info", "code", fmt.Sprintf("m%d", i))
	}
	// Buffer holds at most 5: the 8 pushes evicted events and recorded an
	// events_dropped notice each time. Close first so any batch in flight to
	// the dead endpoint is restored before inspecting the queue.
	client.Close()
	client.mu.Lock()
	queue := client.queues["s1"]
	client.mu.Unlock()
	if len(queue) > 5 {
		t.Fatalf("buffer exceeds cap: %d", len(queue))
	}
	found := false
	for _, ev := range queue {
		if ev.Log != nil && ev.Log.Code == "events_dropped" && ev.Log.Level == "error" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected an events_dropped log event in the buffer")
	}
}

func TestEmittedAtFormat(t *testing.T) {
	rec := &receiver{}
	srv := httptest.NewServer(http.HandlerFunc(rec.handler))
	t.Cleanup(srv.Close)
	client := newTestClient(t, srv, Config{})

	client.Log("s1", "info", "c", "m")
	waitFor(t, "delivery", func() bool { return rec.count() == 1 })
	emitted := rec.events()[0].Log.EmittedAt
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", emitted); err != nil {
		t.Fatalf("emittedAt %q is not ISO 8601 with milliseconds: %v", emitted, err)
	}
}
