package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func newTestProvider(t *testing.T, format string, servers ...*httptest.Server) *OpenAICompat {
	t.Helper()
	urls := make([]string, len(servers))
	for i, server := range servers {
		urls[i] = server.URL
	}
	provider, err := NewOpenAICompat(OpenAICompatConfig{
		URLs:           urls,
		Model:          "test-model",
		AudioFormat:    format,
		MaxConcurrency: 2,
		Timeout:        5 * time.Second,
		Temperature:    0.2,
	})
	if err != nil {
		t.Fatalf("NewOpenAICompat: %v", err)
	}
	provider.probeInterval = 10 * time.Millisecond
	t.Cleanup(provider.Close)
	return provider
}

// completionsHandler captures each request body and replies with a canned
// chat-completions response. Serve /health too so probe tests can share it.
type completionsHandler struct {
	body    chan []byte
	replies chan string
	status  chan int
}

func (h *completionsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" {
		w.WriteHeader(http.StatusOK)
		return
	}
	data, _ := io.ReadAll(r.Body)
	if h.body != nil {
		h.body <- data
	}
	status := http.StatusOK
	if h.status != nil {
		select {
		case status = <-h.status:
		default:
		}
	}
	if status != http.StatusOK {
		w.WriteHeader(status)
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
		"choices": []map[string]any{{
			"finish_reason": "stop",
			"message":       map[string]any{"role": "assistant", "content": reply},
		}},
	})
}

func captureBody(t *testing.T, ch <-chan []byte) chatRequest {
	t.Helper()
	var body chatRequest
	select {
	case raw := <-ch:
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("request body is not JSON: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a request")
	}
	return body
}

func assertCommonFields(t *testing.T, body chatRequest) {
	t.Helper()
	if body.Model != "test-model" {
		t.Fatalf("model: got %q", body.Model)
	}
	if body.Temperature != 0.2 || body.TopP != 0.95 || body.TopK != 64 || body.MaxTokens != 256 {
		t.Fatalf("sampling fields: %+v", body)
	}
	if body.ChatTemplateKwargs.EnableThinking {
		t.Fatal("chat_template_kwargs.enable_thinking must be false")
	}
	if len(body.Messages) != 1 || body.Messages[0].Role != "user" {
		t.Fatalf("messages: %+v", body.Messages)
	}
}

func TestOpenAICompatRequestBodyInputAudio(t *testing.T) {
	handler := &completionsHandler{body: make(chan []byte, 1)}
	handler.replies = make(chan string, 1)
	handler.replies <- "hello\nSpanish: hola"
	provider := newTestProvider(t, "input_audio", httptest.NewServer(handler))

	audio := WAV{Data: []byte("fake wav"), Index: 1}
	result, ok, err := provider.TranscribeAndTranslate(context.Background(), audio, ASTRequest{SourceLanguage: "en", TargetLanguage: "es"})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("openai-compat must support single-call AST")
	}
	if result.Transcript.Text != "hello" || result.Translation != "hola" {
		t.Fatalf("AST result: %+v", result)
	}

	body := captureBody(t, handler.body)
	assertCommonFields(t, body)
	content := body.Messages[0].Content
	if len(content) != 2 {
		t.Fatalf("content blocks: %+v", content)
	}
	if content[0].Type != "input_audio" || content[0].InputAudio == nil {
		t.Fatalf("first block must be input_audio: %+v", content[0])
	}
	if content[0].InputAudio.Format != "wav" ||
		content[0].InputAudio.Data != base64.StdEncoding.EncodeToString(audio.Data) {
		t.Fatalf("input_audio payload: %+v", content[0].InputAudio)
	}
	if content[1].Type != "text" || content[1].Text == "" {
		t.Fatalf("second block must be the prompt text: %+v", content[1])
	}
}

func TestOpenAICompatRequestBodyAudioURL(t *testing.T) {
	handler := &completionsHandler{body: make(chan []byte, 1)}
	provider := newTestProvider(t, "audio_url", httptest.NewServer(handler))

	audio := WAV{Data: []byte("fake wav")}
	if _, err := provider.Transcribe(context.Background(), audio, TranscribeRequest{SourceLanguage: "en"}); err != nil {
		t.Fatal(err)
	}

	body := captureBody(t, handler.body)
	assertCommonFields(t, body)
	content := body.Messages[0].Content
	want := "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(audio.Data)
	if content[0].Type != "audio_url" || content[0].AudioURL == nil || content[0].AudioURL.URL != want {
		t.Fatalf("first block must be a data-URI audio_url: %+v", content[0])
	}
	if content[1].Type != "text" || content[1].Text == "" {
		t.Fatalf("second block must be the prompt text: %+v", content[1])
	}
}

func TestOpenAICompatASTAndTranslate(t *testing.T) {
	handler := &completionsHandler{body: make(chan []byte, 4)}
	handler.replies = make(chan string, 2)
	handler.replies <- "transcript here\nSpanish: traducción"
	handler.replies <- "hola mundo"
	server := httptest.NewServer(handler)
	provider := newTestProvider(t, "input_audio", server)

	result, ok, err := provider.TranscribeAndTranslate(context.Background(), WAV{Data: []byte("w")}, ASTRequest{SourceLanguage: "en", TargetLanguage: "es"})
	if err != nil || !ok {
		t.Fatalf("AST call: ok=%v err=%v", ok, err)
	}
	if result.Transcript.Text != "transcript here" || result.Translation != "traducción" {
		t.Fatalf("AST result: %+v", result)
	}

	translation, err := provider.Translate(context.Background(), "hello world", TranslateRequest{SourceLanguage: "en", TargetLanguage: "es"})
	if err != nil {
		t.Fatal(err)
	}
	if translation != "hola mundo" {
		t.Fatalf("translation: %q", translation)
	}
	// The translate request must be a single text block, no audio.
	<-handler.body // AST request already consumed
	body := captureBody(t, handler.body)
	if len(body.Messages[0].Content) != 1 || body.Messages[0].Content[0].Type != "text" {
		t.Fatalf("translate must send text only: %+v", body.Messages[0].Content)
	}
}

func TestOpenAICompatRetryOn5xx(t *testing.T) {
	failing := &completionsHandler{status: make(chan int, 8)}
	failing.status <- http.StatusBadGateway
	broken := httptest.NewServer(failing)
	var goodCalls atomic.Int32
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		goodCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"finish_reason": "stop",
				"message":       map[string]any{"role": "assistant", "content": "recovered"},
			}},
		})
	}))
	provider := newTestProvider(t, "input_audio", broken, good)

	transcript, err := provider.Transcribe(context.Background(), WAV{Data: []byte("w")}, TranscribeRequest{SourceLanguage: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if transcript.Text != "recovered" {
		t.Fatalf("transcript: %q", transcript.Text)
	}
	if goodCalls.Load() != 1 {
		t.Fatalf("expected 1 call to the healthy endpoint, got %d", goodCalls.Load())
	}
}

func TestOpenAICompatNoRetryOn4xx(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"bad prompt"}}`))
	}))
	provider := newTestProvider(t, "input_audio", server)

	_, err := provider.Transcribe(context.Background(), WAV{Data: []byte("w")}, TranscribeRequest{SourceLanguage: "en"})
	var requestErr *RequestError
	if !errors.As(err, &requestErr) {
		t.Fatalf("expected RequestError, got %v", err)
	}
	if requestErr.Status != http.StatusBadRequest || requestErr.Message != "bad prompt" {
		t.Fatalf("RequestError: %+v", requestErr)
	}
	if calls.Load() != 1 {
		t.Fatalf("4xx must not be retried, got %d calls", calls.Load())
	}
	// Repeated 4xx responses must not mark the endpoint unhealthy.
	for i := 0; i < maxConsecutiveFailures; i++ {
		_, _ = provider.Transcribe(context.Background(), WAV{Data: []byte("w")}, TranscribeRequest{SourceLanguage: "en"})
	}
	if !provider.Healthy() {
		t.Fatal("4xx rejections must not affect endpoint health")
	}
}

func TestOpenAICompatUnhealthyMarkingAndRecovery(t *testing.T) {
	var calls atomic.Int32
	var serveOK atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			if serveOK.Load() {
				w.WriteHeader(http.StatusOK)
			} else {
				w.WriteHeader(http.StatusServiceUnavailable)
			}
			return
		}
		calls.Add(1)
		if serveOK.Load() {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{{
					"finish_reason": "stop",
					"message":       map[string]any{"role": "assistant", "content": "back"},
				}},
			})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	provider := newTestProvider(t, "input_audio", server)

	for i := 0; i < maxConsecutiveFailures; i++ {
		if _, err := provider.Transcribe(context.Background(), WAV{Data: []byte("w")}, TranscribeRequest{SourceLanguage: "en"}); err == nil {
			t.Fatal("expected an error while the endpoint fails")
		}
	}
	if provider.Healthy() {
		t.Fatal("endpoint must be unhealthy after 3 consecutive 5xx")
	}
	if _, err := provider.Transcribe(context.Background(), WAV{Data: []byte("w")}, TranscribeRequest{SourceLanguage: "en"}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("expected ErrUnavailable, got %v", err)
	}
	if got := calls.Load(); int(got) != maxConsecutiveFailures {
		t.Fatalf("unhealthy endpoint must not receive requests, got %d calls", got)
	}

	// Once /health answers the probe restores the endpoint and traffic resumes.
	serveOK.Store(true)
	deadline := time.Now().Add(3 * time.Second)
	for !provider.Healthy() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !provider.Healthy() {
		t.Fatal("endpoint did not recover after /health started answering")
	}
	transcript, err := provider.Transcribe(context.Background(), WAV{Data: []byte("w")}, TranscribeRequest{SourceLanguage: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if transcript.Text != "back" {
		t.Fatalf("transcript after recovery: %q", transcript.Text)
	}
}

func TestOpenAICompatRoundRobin(t *testing.T) {
	var first, second atomic.Int32
	counting := func(counter *atomic.Int32) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			counter.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{{
					"finish_reason": "stop",
					"message":       map[string]any{"role": "assistant", "content": "ok"},
				}},
			})
		}
	}
	provider := newTestProvider(t, "input_audio",
		httptest.NewServer(counting(&first)), httptest.NewServer(counting(&second)))

	for i := 0; i < 4; i++ {
		if _, err := provider.Transcribe(context.Background(), WAV{Data: []byte("w")}, TranscribeRequest{SourceLanguage: "en"}); err != nil {
			t.Fatal(err)
		}
	}
	if first.Load() != 2 || second.Load() != 2 {
		t.Fatalf("round-robin expected 2 calls each, got %d and %d", first.Load(), second.Load())
	}
}

func TestOpenAICompatSemaphoreBound(t *testing.T) {
	var inFlight, maxSeen atomic.Int32
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := inFlight.Add(1)
		for {
			if seen := maxSeen.Load(); current <= seen || maxSeen.CompareAndSwap(seen, current) {
				break
			}
		}
		<-release
		inFlight.Add(-1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"finish_reason": "stop",
				"message":       map[string]any{"role": "assistant", "content": "ok"},
			}},
		})
	}))
	provider, err := NewOpenAICompat(OpenAICompatConfig{
		URLs:           []string{server.URL},
		Model:          "test-model",
		AudioFormat:    "input_audio",
		MaxConcurrency: 1,
		Timeout:        10 * time.Second,
		Temperature:    0.2,
	})
	if err != nil {
		t.Fatal(err)
	}
	provider.probeInterval = 10 * time.Millisecond
	t.Cleanup(provider.Close)

	done := make(chan error, 3)
	for i := 0; i < 3; i++ {
		go func() {
			_, err := provider.Transcribe(context.Background(), WAV{Data: []byte("w")}, TranscribeRequest{SourceLanguage: "en"})
			done <- err
		}()
	}
	for i := 0; i < 3; i++ {
		time.Sleep(20 * time.Millisecond)
		release <- struct{}{}
	}
	for i := 0; i < 3; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if maxSeen.Load() != 1 {
		t.Fatalf("expected at most 1 in-flight request, saw %d", maxSeen.Load())
	}
}

func TestOpenAICompatBadOutputFallsBack(t *testing.T) {
	handler := &completionsHandler{}
	handler.replies = make(chan string, 1)
	handler.replies <- "output without the marker"
	provider := newTestProvider(t, "input_audio", httptest.NewServer(handler))

	result, ok, err := provider.TranscribeAndTranslate(context.Background(), WAV{Data: []byte("w")}, ASTRequest{SourceLanguage: "en", TargetLanguage: "es"})
	if ok {
		t.Fatal("unparseable AST output must report ok=false")
	}
	if !errors.Is(err, ErrBadOutput) {
		t.Fatalf("expected ErrBadOutput, got %v", err)
	}
	if result.Transcript.Text != "output without the marker" {
		t.Fatalf("raw output must be kept as transcript: %q", result.Transcript.Text)
	}
}

func TestOpenAICompatTruncatedOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"finish_reason": "length",
				"message":       map[string]any{"role": "assistant", "content": "partial"},
			}},
		})
	}))
	provider := newTestProvider(t, "input_audio", server)

	if _, err := provider.Transcribe(context.Background(), WAV{Data: []byte("w")}, TranscribeRequest{SourceLanguage: "en"}); err == nil {
		t.Fatal("finish_reason=length must be an error")
	}
}
