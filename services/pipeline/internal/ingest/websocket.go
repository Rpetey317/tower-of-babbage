package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

// errProtocol marks any deviation from the ingest protocol (contract
// section 4): missing or malformed hello, a wrong audio format, or an
// unknown text message.
var errProtocol = errors.New("protocol error")

// Handler serves the ingest WebSocket endpoint (contract section 4):
// GET /v1/sessions/{sessionId}/ingest?token=<ingest token>. It owns the
// producers map so a newer connection replaces the active one per run.
type Handler struct {
	sessions Sessions
	secret   string
	events   Events
	logger   *slog.Logger

	helloTimeout  time.Duration // contract: 5 s to send hello after upgrading
	statsInterval time.Duration // contract: stats every 2 s

	mu        sync.Mutex
	producers map[string]*websocket.Conn // sessionID -> active producer
}

// NewHandler builds the WebSocket endpoint. sessions may be nil until the
// session runner exists; every connection then closes with 4004.
func NewHandler(sessions Sessions, sharedSecret string, events Events, logger *slog.Logger) *Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{
		sessions:      sessions,
		secret:        sharedSecret,
		events:        events,
		logger:        logger,
		helloTimeout:  5 * time.Second,
		statsInterval: 2 * time.Second,
		producers:     make(map[string]*websocket.Conn),
	}
}

// ServeHTTP upgrades the request and drives the protocol: token check,
// session lookup, hello, ready, then binary frames until close or end.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")
	// Origin is not checked: browsers reach this endpoint cross-origin from the
	// web app, and authentication is the ingest token in the query string.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		h.logger.Warn("ingest upgrade failed", "sessionId", sessionID, "error", err)
		return
	}
	defer conn.CloseNow()

	if !contract.VerifyIngestToken(r.URL.Query().Get("token"), sessionID, h.secret, time.Now()) {
		h.close(conn, closeInvalidToken, "invalid or expired token")
		return
	}
	var sink Sink
	if h.sessions != nil {
		sink, _ = h.sessions.Lookup(sessionID)
	}
	if sink == nil {
		h.close(conn, closeNotRunning, "session not running")
		return
	}

	if err := h.readHello(r.Context(), conn); err != nil {
		h.logger.Warn("ingest hello failed", "sessionId", sessionID, "error", err)
		h.close(conn, closeProtocolError, "expected hello with pcm_s16le/16000/1")
		return
	}
	ready, err := json.Marshal(contract.IngestReady{
		Type:      "ready",
		SessionID: sessionID,
		RunID:     sink.RunID(),
	})
	if err == nil {
		err = conn.Write(r.Context(), websocket.MessageText, ready)
	}
	if err != nil {
		h.close(conn, websocket.StatusInternalError, "internal error")
		return
	}

	h.register(sessionID, conn)
	defer h.unregister(sessionID, conn)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	var clock chunk.Clock
	var received atomic.Int64 // mirrors the clock for the stats goroutine
	go h.statsLoop(ctx, conn, sink, &received)

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return // closed by the client, replaced (4009), or dropped
		}
		switch typ {
		case websocket.MessageBinary:
			if len(data)%2 == 1 {
				data = data[:len(data)-1] // trailing byte cannot complete a sample
			}
			if len(data) > 0 {
				sink.Push(clock.NextFrame(data))
				received.Store(clock.ReceivedMs())
			}
		case websocket.MessageText:
			var head struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(data, &head); err != nil || head.Type != "end" {
				h.close(conn, closeProtocolError, "unknown message")
				return
			}
			sink.Flush()
		}
	}
}

// readHello waits for the single hello text frame the client must send within
// helloTimeout of upgrading (contract step 1). The read runs in a goroutine
// because a read context expiring closes the connection in coder/websocket,
// which would make the 4000 close frame undeliverable.
func (h *Handler) readHello(ctx context.Context, conn *websocket.Conn) error {
	type result struct {
		typ  websocket.MessageType
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		typ, data, err := conn.Read(ctx)
		done <- result{typ, data, err}
	}()
	timer := time.NewTimer(h.helloTimeout)
	defer timer.Stop()

	var typ websocket.MessageType
	var data []byte
	select {
	case res := <-done:
		if res.err != nil {
			return res.err
		}
		typ, data = res.typ, res.data
	case <-timer.C:
		return fmt.Errorf("no hello within %s", h.helloTimeout)
	case <-ctx.Done():
		return ctx.Err()
	}

	if typ != websocket.MessageText {
		return errProtocol
	}
	var hello contract.IngestHello
	if err := json.Unmarshal(data, &hello); err != nil {
		return err
	}
	if hello.Type != "hello" || hello.Format != "pcm_s16le" || hello.SampleRate != chunk.SampleRate || hello.Channels != 1 {
		return errProtocol
	}
	return nil
}

// statsLoop pushes the contract stats message every statsInterval until ctx
// is done; audioReceivedMs mirrors the producer's audio clock.
func (h *Handler) statsLoop(ctx context.Context, conn *websocket.Conn, sink Sink, received *atomic.Int64) {
	ticker := time.NewTicker(h.statsInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		stats, err := json.Marshal(contract.IngestStats{
			Type:            "stats",
			AudioReceivedMs: int(received.Load()),
			QueueDepth:      sink.QueueDepth(),
		})
		if err != nil {
			return
		}
		if err := conn.Write(ctx, websocket.MessageText, stats); err != nil {
			return
		}
	}
}

// register makes conn the session's producer, closing and reporting the
// previous one per the one-producer-per-run rule.
func (h *Handler) register(sessionID string, conn *websocket.Conn) {
	h.mu.Lock()
	old := h.producers[sessionID]
	h.producers[sessionID] = conn
	h.mu.Unlock()
	if old != nil {
		_ = old.Close(closeReplaced, "replaced by a newer producer")
		logEvent(h.events, sessionID, "info", "ingest_replaced", "a new producer connected")
	}
}

// unregister drops conn from the producers map when it is still current.
func (h *Handler) unregister(sessionID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.producers[sessionID] == conn {
		delete(h.producers, sessionID)
	}
}

func (h *Handler) close(conn *websocket.Conn, code websocket.StatusCode, reason string) {
	if err := conn.Close(code, reason); err != nil {
		h.logger.Debug("ingest close failed", "code", code, "error", err)
	}
}
