package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

// newTestServer mounts the handler on the contract route and returns it plus
// a dialer for ingest URLs.
func newTestServer(t *testing.T, h *Handler) (server *httptest.Server, dial func(sessionID, token string) *websocket.Conn) {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("GET /v1/sessions/{sessionId}/ingest", h)
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)
	base := "ws" + strings.TrimPrefix(server.URL, "http")
	return server, func(sessionID, token string) *websocket.Conn {
		url := fmt.Sprintf("%s/v1/sessions/%s/ingest?token=%s", base, sessionID, token)
		conn, _, err := websocket.Dial(context.Background(), url, nil)
		if err != nil {
			t.Fatalf("dial %s: %v", url, err)
		}
		return conn
	}
}

// closeCode reads until the peer closes and returns its close code.
func closeCode(t *testing.T, conn *websocket.Conn) websocket.StatusCode {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, _, err := conn.Read(ctx)
		if err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func sendHello(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	hello, _ := json.Marshal(contract.IngestHello{
		Type: "hello", Format: "pcm_s16le", SampleRate: 16000, Channels: 1,
	})
	if err := conn.Write(context.Background(), websocket.MessageText, hello); err != nil {
		t.Fatalf("write hello: %v", err)
	}
}

func readJSON(t *testing.T, conn *websocket.Conn, target any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	typ, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("expected text message, got %v", typ)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatalf("unmarshal %s: %v", data, err)
	}
}

func runningSession() (fakeSessions, *fakeSink) {
	sink := &fakeSink{runID: "run-test-1"}
	return fakeSessions{testSessionID: sink}, sink
}

func TestInvalidTokenCloses4001(t *testing.T) {
	sessions, _ := runningSession()
	h := NewHandler(sessions, testSecret, nil, nil)
	_, dial := newTestServer(t, h)

	valid := mintToken(t, testSecret, testSessionID, time.Now().Add(time.Minute))
	other := mintToken(t, testSecret, "99999999-8888-7777-6666-555555555555", time.Now().Add(time.Minute))
	expired := mintToken(t, testSecret, testSessionID, time.Now().Add(-time.Minute))
	badSig := valid[:len(valid)-2] + "xx"

	for name, token := range map[string]string{
		"missing":        "",
		"garbage":        "not-a-token",
		"bad signature":  badSig,
		"wrong session":  other,
		"expired":        expired,
		"foreign secret": mintToken(t, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", testSessionID, time.Now().Add(time.Minute)),
	} {
		t.Run(name, func(t *testing.T) {
			conn := dial(testSessionID, token)
			defer conn.CloseNow()
			if code := closeCode(t, conn); code != closeInvalidToken {
				t.Fatalf("expected close %d, got %d", closeInvalidToken, code)
			}
		})
	}
}

func TestSessionNotRunningCloses4004(t *testing.T) {
	h := NewHandler(fakeSessions{}, testSecret, nil, nil)
	_, dial := newTestServer(t, h)

	token := mintToken(t, testSecret, testSessionID, time.Now().Add(time.Minute))
	conn := dial(testSessionID, token)
	defer conn.CloseNow()
	if code := closeCode(t, conn); code != closeNotRunning {
		t.Fatalf("expected close %d, got %d", closeNotRunning, code)
	}
}

func TestNilSessionsCloses4004(t *testing.T) {
	// Main wires the handler with a nil registry until M1-11 exists.
	h := NewHandler(nil, testSecret, nil, nil)
	_, dial := newTestServer(t, h)

	token := mintToken(t, testSecret, testSessionID, time.Now().Add(time.Minute))
	conn := dial(testSessionID, token)
	defer conn.CloseNow()
	if code := closeCode(t, conn); code != closeNotRunning {
		t.Fatalf("expected close %d, got %d", closeNotRunning, code)
	}
}

func TestHelloTimeoutCloses4000(t *testing.T) {
	sessions, _ := runningSession()
	h := NewHandler(sessions, testSecret, nil, nil)
	h.helloTimeout = 50 * time.Millisecond
	_, dial := newTestServer(t, h)

	token := mintToken(t, testSecret, testSessionID, time.Now().Add(time.Minute))
	conn := dial(testSessionID, token)
	defer conn.CloseNow()
	if code := closeCode(t, conn); code != closeProtocolError {
		t.Fatalf("expected close %d, got %d", closeProtocolError, code)
	}
}

func TestBadHelloCloses4000(t *testing.T) {
	cases := map[string]func(t *testing.T, conn *websocket.Conn){
		"wrong format": func(t *testing.T, conn *websocket.Conn) {
			msg, _ := json.Marshal(contract.IngestHello{Type: "hello", Format: "opus", SampleRate: 16000, Channels: 1})
			_ = conn.Write(context.Background(), websocket.MessageText, msg)
		},
		"wrong sample rate": func(t *testing.T, conn *websocket.Conn) {
			msg, _ := json.Marshal(contract.IngestHello{Type: "hello", Format: "pcm_s16le", SampleRate: 8000, Channels: 1})
			_ = conn.Write(context.Background(), websocket.MessageText, msg)
		},
		"wrong type": func(t *testing.T, conn *websocket.Conn) {
			_ = conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"end"}`))
		},
		"binary first": func(t *testing.T, conn *websocket.Conn) {
			_ = conn.Write(context.Background(), websocket.MessageBinary, make([]byte, 6400))
		},
		"invalid json": func(t *testing.T, conn *websocket.Conn) {
			_ = conn.Write(context.Background(), websocket.MessageText, []byte(`{`))
		},
	}
	for name, send := range cases {
		t.Run(name, func(t *testing.T) {
			sessions, _ := runningSession()
			h := NewHandler(sessions, testSecret, nil, nil)
			_, dial := newTestServer(t, h)

			token := mintToken(t, testSecret, testSessionID, time.Now().Add(time.Minute))
			conn := dial(testSessionID, token)
			defer conn.CloseNow()
			send(t, conn)
			if code := closeCode(t, conn); code != closeProtocolError {
				t.Fatalf("expected close %d, got %d", closeProtocolError, code)
			}
		})
	}
}

func TestReadyFramesStatsAndEnd(t *testing.T) {
	sessions, sink := runningSession()
	h := NewHandler(sessions, testSecret, nil, nil)
	h.statsInterval = 20 * time.Millisecond
	_, dial := newTestServer(t, h)

	token := mintToken(t, testSecret, testSessionID, time.Now().Add(time.Minute))
	conn := dial(testSessionID, token)
	defer conn.CloseNow()

	sendHello(t, conn)
	var ready contract.IngestReady
	readJSON(t, conn, &ready)
	if ready.Type != "ready" || ready.SessionID != testSessionID || ready.RunID != "run-test-1" {
		t.Fatalf("unexpected ready: %+v", ready)
	}

	for i := 0; i < 3; i++ {
		if err := conn.Write(context.Background(), websocket.MessageBinary, make([]byte, 6400)); err != nil {
			t.Fatalf("write frame %d: %v", i, err)
		}
	}
	waitFor(t, "3 pushed frames", func() bool { return sink.frameCount() == 3 })
	for i, wantMs := range []int64{0, 200, 400} {
		frame := sink.frameAt(i)
		if frame.StartMs != wantMs || len(frame.PCM) != 6400 {
			t.Fatalf("frame %d: got start %d len %d, want start %d len 6400", i, frame.StartMs, len(frame.PCM), wantMs)
		}
	}

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"end"}`)); err != nil {
		t.Fatalf("write end: %v", err)
	}
	waitFor(t, "flush", func() bool { return sink.flushCount() >= 1 })

	// Stats arrive on the same socket; read until one reflects the 600 ms received.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var stats contract.IngestStats
		readJSON(t, conn, &stats)
		if stats.Type != "stats" {
			t.Fatalf("expected stats message, got %+v", stats)
		}
		if stats.AudioReceivedMs == 600 {
			if stats.QueueDepth != sink.queueDepth {
				t.Fatalf("queueDepth %d, want %d", stats.QueueDepth, sink.queueDepth)
			}
			return
		}
	}
	t.Fatal("no stats message reached audioReceivedMs=600")
}

func TestUnknownTextMessageCloses4000(t *testing.T) {
	sessions, _ := runningSession()
	h := NewHandler(sessions, testSecret, nil, nil)
	_, dial := newTestServer(t, h)

	token := mintToken(t, testSecret, testSessionID, time.Now().Add(time.Minute))
	conn := dial(testSessionID, token)
	defer conn.CloseNow()

	sendHello(t, conn)
	var ready contract.IngestReady
	readJSON(t, conn, &ready)

	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"bogus"}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if code := closeCode(t, conn); code != closeProtocolError {
		t.Fatalf("expected close %d, got %d", closeProtocolError, code)
	}
}

func TestProducerReplacementCloses4009(t *testing.T) {
	sessions, sink := runningSession()
	events := &fakeEvents{}
	h := NewHandler(sessions, testSecret, events, nil)
	_, dial := newTestServer(t, h)

	token := mintToken(t, testSecret, testSessionID, time.Now().Add(time.Minute))

	first := dial(testSessionID, token)
	defer first.CloseNow()
	sendHello(t, first)
	var ready contract.IngestReady
	readJSON(t, first, &ready)

	second := dial(testSessionID, token)
	defer second.CloseNow()
	sendHello(t, second)
	readJSON(t, second, &ready)

	if code := closeCode(t, first); code != closeReplaced {
		t.Fatalf("expected close %d on replaced producer, got %d", closeReplaced, code)
	}
	waitFor(t, "ingest_replaced log event", func() bool { return events.hasCode("ingest_replaced") })

	// The newer producer keeps working on the same run.
	if err := second.Write(context.Background(), websocket.MessageBinary, make([]byte, 6400)); err != nil {
		t.Fatalf("write frame on replacement: %v", err)
	}
	waitFor(t, "replacement frame", func() bool { return sink.frameCount() == 1 })
}
