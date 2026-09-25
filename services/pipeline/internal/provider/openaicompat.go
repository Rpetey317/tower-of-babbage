package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var _ SpeechProvider = (*OpenAICompat)(nil)

const (
	// maxEndpointAttempts bounds a call to the first endpoint plus one retry
	// on a different endpoint.
	maxEndpointAttempts = 2
	// maxConsecutiveFailures marks an endpoint unhealthy after this many
	// transport errors or 5xx in a row; 4xx rejections do not count.
	maxConsecutiveFailures = 3
	defaultProbeInterval   = 5 * time.Second
	probeTimeout           = 2 * time.Second
	maxResponseBytes       = 1 << 20
)

// OpenAICompatConfig selects the endpoints and request parameters for the
// OpenAI-compatible provider; values come from the INFERENCE_* variables
// documented in docs/stack.md.
type OpenAICompatConfig struct {
	// URLs is the list of base URLs (INFERENCE_URLS); at least one is required.
	URLs []string
	// Model is the `model` field sent in requests; llama-server ignores it,
	// vLLM needs the HF id.
	Model string
	// AudioFormat is `input_audio` (llama.cpp) or `audio_url` (vLLM).
	AudioFormat string
	// MaxConcurrency bounds in-flight requests per endpoint; match
	// llama-server `--parallel`.
	MaxConcurrency int
	// Timeout bounds a single request attempt.
	Timeout time.Duration
	// Temperature is the sampling temperature; top_p 0.95 and top_k 64 are
	// fixed per Google's Gemma 4 guidance.
	Temperature float64
}

// OpenAICompat speaks `POST {endpoint}/v1/chat/completions` against one or more
// OpenAI-compatible servers (llama.cpp llama-server, vLLM). Requests
// round-robin across healthy endpoints with a per-endpoint semaphore; an
// endpoint that fails maxConsecutiveFailures times is probed with GET /health
// until it answers. Safe for concurrent use.
type OpenAICompat struct {
	client        *http.Client
	model         string
	format        string
	temperature   float64
	timeout       time.Duration
	endpoints     []*openAIEndpoint
	next          atomic.Int64
	probeInterval time.Duration
	probeCtx      context.Context
	probeCancel   context.CancelFunc
	probers       sync.WaitGroup
}

// openAIEndpoint is one inference server with its health state and the
// semaphore bounding in-flight requests to it.
type openAIEndpoint struct {
	base string
	sem  chan struct{}

	mu       sync.Mutex
	healthy  bool
	failures int
	probing  bool
}

// NewOpenAICompat validates the configuration and returns the provider.
func NewOpenAICompat(cfg OpenAICompatConfig) (*OpenAICompat, error) {
	if len(cfg.URLs) == 0 {
		return nil, errors.New("openaicompat: at least one endpoint URL is required")
	}
	if cfg.AudioFormat != "input_audio" && cfg.AudioFormat != "audio_url" {
		return nil, fmt.Errorf("openaicompat: unsupported audio format %q", cfg.AudioFormat)
	}
	if cfg.Model == "" {
		return nil, errors.New("openaicompat: model must not be empty")
	}
	if cfg.MaxConcurrency < 1 {
		return nil, errors.New("openaicompat: max concurrency must be at least 1")
	}
	if cfg.Timeout <= 0 {
		return nil, errors.New("openaicompat: timeout must be positive")
	}
	probeCtx, probeCancel := context.WithCancel(context.Background())
	provider := &OpenAICompat{
		client:        &http.Client{},
		model:         cfg.Model,
		format:        cfg.AudioFormat,
		temperature:   cfg.Temperature,
		timeout:       cfg.Timeout,
		probeInterval: defaultProbeInterval,
		probeCtx:      probeCtx,
		probeCancel:   probeCancel,
	}
	for _, raw := range cfg.URLs {
		base := strings.TrimRight(strings.TrimSpace(raw), "/")
		if base == "" {
			return nil, errors.New("openaicompat: endpoint URL must not be empty")
		}
		provider.endpoints = append(provider.endpoints, &openAIEndpoint{
			base:    base,
			sem:     make(chan struct{}, cfg.MaxConcurrency),
			healthy: true,
		})
	}
	return provider, nil
}

// Close stops the health probers; in-flight requests are unaffected.
func (o *OpenAICompat) Close() {
	o.probeCancel()
	o.probers.Wait()
}

// Healthy reports whether at least one endpoint is usable.
func (o *OpenAICompat) Healthy() bool {
	for _, endpoint := range o.endpoints {
		if endpoint.isHealthy() {
			return true
		}
	}
	return false
}

func (o *OpenAICompat) Transcribe(ctx context.Context, audio WAV, req TranscribeRequest) (Transcript, error) {
	prompt, err := ASRPrompt(req.SourceLanguage, req.Glossary)
	if err != nil {
		return "", err
	}
	content, err := o.complete(ctx, o.buildRequest(&audio, prompt))
	if err != nil {
		return "", err
	}
	return Transcript(collapseSpaces(content)), nil
}

func (o *OpenAICompat) TranscribeAndTranslate(ctx context.Context, audio WAV, req ASTRequest) (ASTResult, bool, error) {
	prompt, err := ASTPrompt(req.SourceLanguage, req.TargetLanguage, req.Glossary)
	if err != nil {
		return ASTResult{}, false, err
	}
	raw, err := o.complete(ctx, o.buildRequest(&audio, prompt))
	if err != nil {
		return ASTResult{}, false, err
	}
	result, err := ParseASTOutput(raw, req.TargetLanguage)
	if err != nil {
		// The raw output is kept as the transcript so the runner can emit it
		// alone and redo the translation with a text call.
		return ASTResult{Transcript: collapseSpaces(raw)}, false, fmt.Errorf("%w: %w", ErrBadOutput, err)
	}
	return result, true, nil
}

func (o *OpenAICompat) Translate(ctx context.Context, text string, req TranslateRequest) (string, error) {
	prompt, err := TranslatePrompt(req.SourceLanguage, req.TargetLanguage, text, req.Glossary)
	if err != nil {
		return "", err
	}
	content, err := o.complete(ctx, o.buildRequest(nil, prompt))
	if err != nil {
		return "", err
	}
	return collapseSpaces(content), nil
}

// complete sends the request to up to maxEndpointAttempts distinct endpoints.
// Transport errors, timeouts and 5xx are retryable on another endpoint; 4xx
// rejections and unparseable responses return immediately.
func (o *OpenAICompat) complete(ctx context.Context, body chatRequest) (string, error) {
	excluded := make(map[*openAIEndpoint]struct{})
	var lastErr error
	for attempt := 0; attempt < maxEndpointAttempts; attempt++ {
		endpoint, err := o.acquire(ctx, excluded)
		if err != nil {
			if lastErr != nil {
				return "", lastErr
			}
			return "", err
		}
		content, retryable, err := o.request(ctx, endpoint, body)
		<-endpoint.sem
		if err == nil {
			return content, nil
		}
		lastErr = err
		if !retryable {
			return "", err
		}
		excluded[endpoint] = struct{}{}
	}
	return "", lastErr
}

// acquire picks the next healthy endpoint in round-robin order and takes a
// semaphore slot. When every healthy endpoint is full it blocks on the first
// one so no capacity sits idle.
func (o *OpenAICompat) acquire(ctx context.Context, excluded map[*openAIEndpoint]struct{}) (*openAIEndpoint, error) {
	var first *openAIEndpoint
	start := int(o.next.Add(1) - 1)
	for i := 0; i < len(o.endpoints); i++ {
		endpoint := o.endpoints[(start+i)%len(o.endpoints)]
		if _, skip := excluded[endpoint]; skip || !endpoint.isHealthy() {
			continue
		}
		if first == nil {
			first = endpoint
		}
		select {
		case endpoint.sem <- struct{}{}:
			return endpoint, nil
		default:
		}
	}
	if first == nil {
		return nil, ErrUnavailable
	}
	select {
	case first.sem <- struct{}{}:
		return first, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// request performs one HTTP attempt on an endpoint and reports whether the
// call may be retried elsewhere.
func (o *OpenAICompat) request(ctx context.Context, endpoint *openAIEndpoint, body chatRequest) (string, bool, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return "", false, fmt.Errorf("openaicompat: encode request: %w", err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, o.timeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint.base+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", false, fmt.Errorf("openaicompat: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := o.client.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return "", false, ctx.Err()
		}
		o.recordFailure(endpoint)
		return "", true, fmt.Errorf("openaicompat: %s: %w", endpoint.base, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		o.recordFailure(endpoint)
		return "", true, fmt.Errorf("openaicompat: %s: read response: %w", endpoint.base, err)
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		endpoint.recordSuccess()
		content, err := parseContent(data)
		return content, false, err
	case resp.StatusCode >= 400 && resp.StatusCode < 500:
		// A 4xx rejection says nothing about endpoint health; it is a
		// request-level error that is logged and the chunk skipped.
		return "", false, &RequestError{Status: resp.StatusCode, Message: errorMessage(data)}
	default:
		o.recordFailure(endpoint)
		return "", true, &RequestError{Status: resp.StatusCode, Message: errorMessage(data)}
	}
}

// recordSuccess clears the consecutive-failure count after a good response.
func (e *openAIEndpoint) recordSuccess() {
	e.mu.Lock()
	e.failures = 0
	e.mu.Unlock()
}

// recordFailure counts a transport error or 5xx; on the third in a row the
// endpoint is marked unhealthy and a prober starts polling GET /health.
func (o *OpenAICompat) recordFailure(endpoint *openAIEndpoint) {
	endpoint.mu.Lock()
	endpoint.failures++
	if endpoint.failures >= maxConsecutiveFailures && endpoint.healthy && !endpoint.probing {
		endpoint.healthy = false
		endpoint.probing = true
		o.probers.Add(1)
		go o.probe(endpoint)
	}
	endpoint.mu.Unlock()
}

// probe polls GET {endpoint}/health until it answers 2xx, then marks the
// endpoint healthy again. Owned by the provider; Close cancels it.
func (o *OpenAICompat) probe(endpoint *openAIEndpoint) {
	defer o.probers.Done()
	ticker := time.NewTicker(o.probeInterval)
	defer ticker.Stop()
	for {
		if o.probeOnce(endpoint) {
			endpoint.mu.Lock()
			endpoint.healthy = true
			endpoint.failures = 0
			endpoint.probing = false
			endpoint.mu.Unlock()
			return
		}
		select {
		case <-o.probeCtx.Done():
			endpoint.mu.Lock()
			endpoint.probing = false
			endpoint.mu.Unlock()
			return
		case <-ticker.C:
		}
	}
}

func (o *OpenAICompat) probeOnce(endpoint *openAIEndpoint) bool {
	ctx, cancel := context.WithTimeout(o.probeCtx, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.base+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := o.client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func (e *openAIEndpoint) isHealthy() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.healthy
}

// chatRequest is the POST /v1/chat/completions body.
type chatRequest struct {
	Model              string             `json:"model"`
	Messages           []chatMessage      `json:"messages"`
	Temperature        float64            `json:"temperature"`
	TopP               float64            `json:"top_p"`
	TopK               int                `json:"top_k"`
	MaxTokens          int                `json:"max_tokens"`
	ChatTemplateKwargs chatTemplateKwargs `json:"chat_template_kwargs"`
}

// chatTemplateKwargs keeps Gemma 4 thinking mode off; it adds latency and
// breaks output parsing.
type chatTemplateKwargs struct {
	EnableThinking bool `json:"enable_thinking"`
}

type chatMessage struct {
	Role    string        `json:"role"`
	Content []chatContent `json:"content"`
}

// chatContent is one content block; which optional field is set depends on
// Type: text, input_audio (llama.cpp) or audio_url (vLLM).
type chatContent struct {
	Type       string       `json:"type"`
	Text       string       `json:"text,omitempty"`
	InputAudio *inputAudio  `json:"input_audio,omitempty"`
	AudioURL   *audioURLRef `json:"audio_url,omitempty"`
}

type inputAudio struct {
	Data   string `json:"data"`
	Format string `json:"format"`
}

type audioURLRef struct {
	URL string `json:"url"`
}

type chatResponse struct {
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

// buildRequest assembles the chat-completions body: one user message with the
// audio block first (when given) and the prompt as text.
func (o *OpenAICompat) buildRequest(audio *WAV, prompt string) chatRequest {
	content := []chatContent{}
	if audio != nil {
		content = append(content, o.audioContent(*audio))
	}
	content = append(content, chatContent{Type: "text", Text: prompt})
	return chatRequest{
		Model:              o.model,
		Messages:           []chatMessage{{Role: "user", Content: content}},
		Temperature:        o.temperature,
		TopP:               0.95,
		TopK:               64,
		MaxTokens:          256,
		ChatTemplateKwargs: chatTemplateKwargs{EnableThinking: false},
	}
}

func (o *OpenAICompat) audioContent(audio WAV) chatContent {
	encoded := base64.StdEncoding.EncodeToString(audio.Data)
	if o.format == "audio_url" {
		return chatContent{Type: "audio_url", AudioURL: &audioURLRef{URL: "data:audio/wav;base64," + encoded}}
	}
	return chatContent{Type: "input_audio", InputAudio: &inputAudio{Data: encoded, Format: "wav"}}
}

// parseContent extracts the assistant text from a 2xx response.
func parseContent(data []byte) (string, error) {
	var response chatResponse
	if err := json.Unmarshal(data, &response); err != nil {
		return "", fmt.Errorf("openaicompat: invalid response: %w", err)
	}
	if len(response.Choices) == 0 {
		return "", errors.New("openaicompat: response has no choices")
	}
	if response.Choices[0].FinishReason == "length" {
		return "", errors.New("openaicompat: model output truncated (finish_reason: length)")
	}
	content := strings.TrimSpace(response.Choices[0].Message.Content)
	if content == "" {
		return "", errors.New("openaicompat: response has no text content")
	}
	return content, nil
}

// errorMessage extracts the API's `error` field from a non-2xx body, falling
// back to a truncated raw body.
func errorMessage(data []byte) string {
	var body struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &body) == nil && len(body.Error) > 0 {
		var object struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(body.Error, &object) == nil && object.Message != "" {
			return object.Message
		}
		var plain string
		if json.Unmarshal(body.Error, &plain) == nil {
			return plain
		}
		return string(body.Error)
	}
	const limit = 200
	text := strings.TrimSpace(string(data))
	if len(text) > limit {
		return text[:limit] + "..."
	}
	return text
}
