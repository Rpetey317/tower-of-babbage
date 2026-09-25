package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newTestGemini(t *testing.T, server *httptest.Server) *Gemini {
	t.Helper()
	gemini, err := NewGemini(GeminiConfig{
		APIKey:         "test-key",
		Model:          "test-model",
		BaseURL:        server.URL,
		MaxConcurrency: 2,
		Timeout:        5 * time.Second,
		Temperature:    0.2,
	})
	if err != nil {
		t.Fatalf("NewGemini: %v", err)
	}
	gemini.trialInterval = 10 * time.Millisecond
	return gemini
}

// capturedRequest records the wire details of one generateContent call.
type capturedRequest struct {
	method string
	path   string
	apiKey string
	body   []byte
}

// geminiHandler answers generateContent requests: queued status codes and
// reply texts when present, 200 with "hello" otherwise.
type geminiHandler struct {
	requests chan capturedRequest
	calls    atomic.Int64
	statuses chan int
	replies  chan string
	delay    time.Duration
}

func (h *geminiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.calls.Add(1)
	if h.delay > 0 {
		time.Sleep(h.delay)
	}
	data, _ := io.ReadAll(r.Body)
	if h.requests != nil {
		h.requests <- capturedRequest{
			method: r.Method,
			path:   r.URL.Path,
			apiKey: r.Header.Get("x-goog-api-key"),
			body:   data,
		}
	}
	status := http.StatusOK
	if h.statuses != nil {
		select {
		case status = <-h.statuses:
		default:
		}
	}
	if status != http.StatusOK {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": status, "message": "boom", "status": "INTERNAL"},
		})
		return
	}
	reply := "hello"
	if h.replies != nil {
		select {
		case reply = <-h.replies:
		default:
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"candidates": []map[string]any{{
			"content":      map[string]any{"role": "model", "parts": []map[string]any{{"text": reply}}},
			"finishReason": "STOP",
		}},
	})
}

func captureGeminiRequest(t *testing.T, ch <-chan capturedRequest) capturedRequest {
	t.Helper()
	select {
	case req := <-ch:
		return req
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a request")
		return capturedRequest{}
	}
}

func TestGeminiRequestShape(t *testing.T) {
	handler := &geminiHandler{
		requests: make(chan capturedRequest, 1),
		replies:  make(chan string, 1),
	}
	handler.replies <- "S1: hello\nSpanish: hola"
	gemini := newTestGemini(t, httptest.NewServer(handler))

	audio := WAV{Data: []byte("fake wav"), Index: 1}
	result, ok, err := gemini.TranscribeAndTranslate(context.Background(), audio,
		ASTRequest{SourceLanguage: "en", TargetLanguage: "es"})
	if err != nil {
		t.Fatalf("TranscribeAndTranslate: %v", err)
	}
	if !ok || result.Transcript.Text != "hello" || result.Transcript.Speaker != "S1" || result.Translation != "hola" {
		t.Fatalf("unexpected AST result: %+v (ok=%v)", result, ok)
	}

	captured := captureGeminiRequest(t, handler.requests)
	if captured.method != http.MethodPost {
		t.Fatalf("method: got %q", captured.method)
	}
	if captured.path != "/v1beta/models/test-model:generateContent" {
		t.Fatalf("path: got %q", captured.path)
	}
	if captured.apiKey != "test-key" {
		t.Fatalf("x-goog-api-key: got %q", captured.apiKey)
	}

	var body geminiRequest
	if err := json.Unmarshal(captured.body, &body); err != nil {
		t.Fatalf("request body is not JSON: %v", err)
	}
	if len(body.Contents) != 1 || len(body.Contents[0].Parts) != 2 {
		t.Fatalf("contents: %+v", body.Contents)
	}
	inline := body.Contents[0].Parts[0].InlineData
	if inline == nil || inline.MimeType != "audio/wav" {
		t.Fatalf("first part must be audio/wav inlineData: %+v", body.Contents[0].Parts[0])
	}
	if inline.Data != base64.StdEncoding.EncodeToString(audio.Data) {
		t.Fatal("inlineData does not carry the base64 WAV")
	}
	prompt := body.Contents[0].Parts[1].Text
	if !strings.Contains(prompt, "English") || !strings.Contains(prompt, "Spanish") {
		t.Fatalf("prompt missing language names: %q", prompt)
	}
	if body.GenerationConfig.Temperature != 0.2 || body.GenerationConfig.MaxOutputTokens != 256 {
		t.Fatalf("generationConfig: %+v", body.GenerationConfig)
	}
	if body.GenerationConfig.ThinkingConfig.ThinkingBudget != 0 {
		t.Fatalf("thinking must stay off: %+v", body.GenerationConfig.ThinkingConfig)
	}
}

func TestGeminiTranslateSendsNoAudio(t *testing.T) {
	handler := &geminiHandler{requests: make(chan capturedRequest, 1)}
	gemini := newTestGemini(t, httptest.NewServer(handler))

	text, err := gemini.Translate(context.Background(), "hello",
		TranslateRequest{SourceLanguage: "en", TargetLanguage: "es"})
	if err != nil {
		t.Fatalf("Translate: %v", err)
	}
	if text != "hello" {
		t.Fatalf("translation: got %q", text)
	}

	captured := captureGeminiRequest(t, handler.requests)
	var body geminiRequest
	if err := json.Unmarshal(captured.body, &body); err != nil {
		t.Fatalf("request body is not JSON: %v", err)
	}
	if len(body.Contents) != 1 || len(body.Contents[0].Parts) != 1 {
		t.Fatalf("translate must send a single text part: %+v", body.Contents)
	}
	part := body.Contents[0].Parts[0]
	if part.InlineData != nil || !strings.Contains(part.Text, "hello") {
		t.Fatalf("unexpected part: %+v", part)
	}
}

func TestGeminiBadOutput(t *testing.T) {
	handler := &geminiHandler{replies: make(chan string, 1)}
	handler.replies <- "no marker line here"
	gemini := newTestGemini(t, httptest.NewServer(handler))

	_, _, err := gemini.TranscribeAndTranslate(context.Background(), WAV{Data: []byte("w")},
		ASTRequest{SourceLanguage: "en", TargetLanguage: "es"})
	if !errors.Is(err, ErrBadOutput) {
		t.Fatalf("expected ErrBadOutput, got %v", err)
	}
}

func TestGeminiRequestErrorIsNotRetried(t *testing.T) {
	handler := &geminiHandler{statuses: make(chan int, 4)}
	handler.statuses <- http.StatusBadRequest
	gemini := newTestGemini(t, httptest.NewServer(handler))

	_, err := gemini.Transcribe(context.Background(), WAV{Data: []byte("w")},
		TranscribeRequest{SourceLanguage: "en"})
	var requestErr *RequestError
	if !errors.As(err, &requestErr) {
		t.Fatalf("expected RequestError, got %v", err)
	}
	if requestErr.Status != http.StatusBadRequest || requestErr.Message != "boom" {
		t.Fatalf("RequestError: %+v", requestErr)
	}
	if handler.calls.Load() != 1 {
		t.Fatalf("4xx must not be retried, got %d calls", handler.calls.Load())
	}
}

func TestGeminiRetriesTransientFailures(t *testing.T) {
	handler := &geminiHandler{
		statuses: make(chan int, 4),
		replies:  make(chan string, 1),
	}
	handler.statuses <- http.StatusInternalServerError
	handler.replies <- "recovered"
	gemini := newTestGemini(t, httptest.NewServer(handler))

	out, err := gemini.Transcribe(context.Background(), WAV{Data: []byte("w")},
		TranscribeRequest{SourceLanguage: "en"})
	if err != nil {
		t.Fatalf("expected retry to succeed, got %v", err)
	}
	if out.Text != "recovered" {
		t.Fatalf("transcript: got %q", out.Text)
	}
	if handler.calls.Load() != 2 {
		t.Fatalf("expected 2 requests, got %d", handler.calls.Load())
	}
}

func TestGeminiExhaustedRetries(t *testing.T) {
	handler := &geminiHandler{statuses: make(chan int, 4)}
	handler.statuses <- http.StatusTooManyRequests
	handler.statuses <- http.StatusServiceUnavailable
	gemini := newTestGemini(t, httptest.NewServer(handler))

	_, err := gemini.Transcribe(context.Background(), WAV{Data: []byte("w")},
		TranscribeRequest{SourceLanguage: "en"})
	if err == nil {
		t.Fatal("expected an error after exhausting retries")
	}
	if handler.calls.Load() != 2 {
		t.Fatalf("expected 2 requests, got %d", handler.calls.Load())
	}
}

func TestGeminiBreakerOpensAndRecovers(t *testing.T) {
	handler := &geminiHandler{statuses: make(chan int, 16)}
	for i := 0; i < 6; i++ {
		handler.statuses <- http.StatusServiceUnavailable
	}
	gemini := newTestGemini(t, httptest.NewServer(handler))

	audio := WAV{Data: []byte("w")}
	for i := 0; i < geminiMaxConsecutiveFailures; i++ {
		if _, err := gemini.Transcribe(context.Background(), audio, TranscribeRequest{SourceLanguage: "en"}); err == nil {
			t.Fatalf("call %d: expected an error", i)
		}
	}
	if gemini.Healthy() {
		t.Fatal("breaker should be open after consecutive failures")
	}
	before := handler.calls.Load()
	if _, err := gemini.Transcribe(context.Background(), audio, TranscribeRequest{SourceLanguage: "en"}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("expected ErrUnavailable while the breaker is open, got %v", err)
	}
	if handler.calls.Load() != before {
		t.Fatal("call should fail fast without hitting the API")
	}

	// After the trial interval one call is admitted; a good answer closes the
	// breaker.
	time.Sleep(2 * gemini.trialInterval)
	out, err := gemini.Transcribe(context.Background(), audio, TranscribeRequest{SourceLanguage: "en"})
	if err != nil {
		t.Fatalf("trial call should have succeeded, got %v", err)
	}
	if out.Text != "hello" || !gemini.Healthy() {
		t.Fatalf("breaker did not recover: %q healthy=%v", out.Text, gemini.Healthy())
	}
}

func TestGeminiEmptyCandidates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"promptFeedback": map[string]any{"blockReason": "SAFETY"},
		})
	}))
	defer server.Close()
	gemini := newTestGemini(t, server)

	_, err := gemini.Transcribe(context.Background(), WAV{Data: []byte("w")},
		TranscribeRequest{SourceLanguage: "en"})
	if err == nil || !strings.Contains(err.Error(), "SAFETY") {
		t.Fatalf("expected a block-reason error, got %v", err)
	}
}

func TestGeminiMaxTokens(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{{
				"content":      map[string]any{"role": "model", "parts": []map[string]any{{"text": "cut off"}}},
				"finishReason": "MAX_TOKENS",
			}},
		})
	}))
	defer server.Close()
	gemini := newTestGemini(t, server)

	_, err := gemini.Transcribe(context.Background(), WAV{Data: []byte("w")},
		TranscribeRequest{SourceLanguage: "en"})
	if err == nil || !strings.Contains(err.Error(), "MAX_TOKENS") {
		t.Fatalf("expected a truncation error, got %v", err)
	}
}

func TestGeminiTimeout(t *testing.T) {
	handler := &geminiHandler{delay: 100 * time.Millisecond}
	gemini := newTestGemini(t, httptest.NewServer(handler))
	gemini.timeout = 20 * time.Millisecond

	_, err := gemini.Transcribe(context.Background(), WAV{Data: []byte("w")},
		TranscribeRequest{SourceLanguage: "en"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected a deadline error, got %v", err)
	}
}

func TestNewGeminiValidation(t *testing.T) {
	base := GeminiConfig{
		APIKey:         "key",
		Model:          "model",
		MaxConcurrency: 1,
		Timeout:        time.Second,
	}
	cases := map[string]GeminiConfig{
		"empty key":        {APIKey: "", Model: base.Model, MaxConcurrency: 1, Timeout: time.Second},
		"empty model":      {APIKey: base.APIKey, Model: "", MaxConcurrency: 1, Timeout: time.Second},
		"zero concurrency": {APIKey: base.APIKey, Model: base.Model, MaxConcurrency: 0, Timeout: time.Second},
		"negative timeout": {APIKey: base.APIKey, Model: base.Model, MaxConcurrency: 1, Timeout: 0},
	}
	for name, cfg := range cases {
		if _, err := NewGemini(cfg); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
	gemini, err := NewGemini(base)
	if err != nil {
		t.Fatalf("valid config: %v", err)
	}
	if gemini.base != defaultGeminiBaseURL {
		t.Fatalf("default base URL: got %q", gemini.base)
	}
}
