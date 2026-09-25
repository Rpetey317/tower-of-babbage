package ingest

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"
)

// testSecret is the SHARED_SECRET from .env.example: base64 of 32 ASCII bytes.
const testSecret = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="

const testSessionID = "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77"

// mintToken reproduces the web app's ingest token (contract section 5).
func mintToken(t *testing.T, secret, sessionID string, exp time.Time) string {
	t.Helper()
	key, err := base64.StdEncoding.DecodeString(secret)
	if err != nil {
		t.Fatalf("bad test secret: %v", err)
	}
	payload, err := json.Marshal(map[string]any{"sessionId": sessionID, "exp": exp.Unix()})
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// fakeSink records what producers deliver, implementing Sink for tests.
type fakeSink struct {
	runID      string
	queueDepth int

	mu      sync.Mutex
	frames  []chunk.Frame
	flushes int
}

func (s *fakeSink) RunID() string { return s.runID }

func (s *fakeSink) Push(frame chunk.Frame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, frame)
}

func (s *fakeSink) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flushes++
}

func (s *fakeSink) QueueDepth() int { return s.queueDepth }

func (s *fakeSink) frameCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.frames)
}

func (s *fakeSink) frameAt(i int) chunk.Frame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.frames[i]
}

func (s *fakeSink) flushCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.flushes
}

// fakeSessions resolves ids from a static map.
type fakeSessions map[string]Sink

func (m fakeSessions) Lookup(sessionID string) (Sink, bool) {
	sink, ok := m[sessionID]
	return sink, ok
}

// fakeEvents records ingest log events.
type fakeEvents struct {
	mu   sync.Mutex
	logs []string
}

func (e *fakeEvents) Log(sessionID, level, code, message string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.logs = append(e.logs, fmt.Sprintf("%s %s %s %s", sessionID, level, code, message))
}

func (e *fakeEvents) hasCode(code string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, l := range e.logs {
		if strings.Contains(l, " "+code+" ") {
			return true
		}
	}
	return false
}

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
