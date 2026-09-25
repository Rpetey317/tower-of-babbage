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
	"time"
)

var _ SpeechProvider = (*Gemini)(nil)

const (
	// defaultGeminiBaseURL is the AI Studio REST endpoint for generateContent.
	defaultGeminiBaseURL = "https://generativelanguage.googleapis.com"
	// geminiMaxAttempts bounds a call to the first request plus one retry.
	geminiMaxAttempts = 2
	// geminiMaxConsecutiveFailures opens the breaker after this many calls in
	// a row exhausted their retries on transport errors, timeouts or 5xx/429.
	geminiMaxConsecutiveFailures = 3
	// defaultGeminiTrialInterval is how often one half-open trial call is
	// admitted while the breaker is open.
	defaultGeminiTrialInterval = 5 * time.Second
)

// GeminiConfig selects the API key and request parameters for the Gemini
// provider; values come from the GEMINI_* and INFERENCE_* variables documented
// in docs/stack.md. BaseURL exists for tests and gateways; empty means the
// public AI Studio endpoint.
type GeminiConfig struct {
	// APIKey is the AI Studio key sent as the x-goog-api-key header.
	APIKey string
	// Model is the model id in the generateContent path (GEMINI_MODEL).
	Model string
	// BaseURL overrides the API origin; mainly for tests.
	BaseURL string
	// MaxConcurrency bounds in-flight generateContent calls.
	MaxConcurrency int
	// Timeout bounds a single request attempt.
	Timeout time.Duration
	// Temperature is the sampling temperature.
	Temperature float64
}

// Gemini speaks `POST /v1beta/models/{model}:generateContent` against the
// Gemini API: the chunk WAV travels base64-encoded as an inlineData part and
// the same ASR/AST/translate prompts as the other providers. A failure
// breaker fails fast with ErrUnavailable during outages and reopens one trial
// call per trialInterval, so the provider self-heals without a background
// prober. Safe for concurrent use.
type Gemini struct {
	client      *http.Client
	base        string
	apiKey      string
	model       string
	temperature float64
	timeout     time.Duration
	sem         chan struct{}

	trialInterval time.Duration

	mu        sync.Mutex
	failures  int
	healthy   bool
	trialing  bool
	nextTrial time.Time
}

// NewGemini validates the configuration and returns the provider.
func NewGemini(cfg GeminiConfig) (*Gemini, error) {
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, errors.New("gemini: API key must not be empty")
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return nil, errors.New("gemini: model must not be empty")
	}
	if cfg.MaxConcurrency < 1 {
		return nil, errors.New("gemini: max concurrency must be at least 1")
	}
	if cfg.Timeout <= 0 {
		return nil, errors.New("gemini: timeout must be positive")
	}
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		base = defaultGeminiBaseURL
	}
	return &Gemini{
		client:        &http.Client{},
		base:          base,
		apiKey:        cfg.APIKey,
		model:         cfg.Model,
		temperature:   cfg.Temperature,
		timeout:       cfg.Timeout,
		sem:           make(chan struct{}, cfg.MaxConcurrency),
		trialInterval: defaultGeminiTrialInterval,
		healthy:       true,
	}, nil
}

// Healthy reports whether the API is reachable: true until three calls in a
// row fail transiently, and again once a trial call gets any HTTP answer.
func (g *Gemini) Healthy() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.healthy
}

func (g *Gemini) Transcribe(ctx context.Context, audio WAV, req TranscribeRequest) (Transcript, error) {
	prompt, err := ASRPrompt(req.SourceLanguage, req.Glossary)
	if err != nil {
		return "", err
	}
	content, err := g.complete(ctx, g.buildRequest(&audio, prompt))
	if err != nil {
		return "", err
	}
	return Transcript(collapseSpaces(content)), nil
}

func (g *Gemini) TranscribeAndTranslate(ctx context.Context, audio WAV, req ASTRequest) (ASTResult, bool, error) {
	prompt, err := ASTPrompt(req.SourceLanguage, req.TargetLanguage, req.Glossary)
	if err != nil {
		return ASTResult{}, false, err
	}
	raw, err := g.complete(ctx, g.buildRequest(&audio, prompt))
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

func (g *Gemini) Translate(ctx context.Context, text string, req TranslateRequest) (string, error) {
	prompt, err := TranslatePrompt(req.SourceLanguage, req.TargetLanguage, text, req.Glossary)
	if err != nil {
		return "", err
	}
	content, err := g.complete(ctx, g.buildRequest(nil, prompt))
	if err != nil {
		return "", err
	}
	return collapseSpaces(content), nil
}

// admit applies the failure breaker: while unhealthy, calls fail fast with
// ErrUnavailable except one admitted trial per trialInterval.
func (g *Gemini) admit() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.healthy {
		return nil
	}
	if g.trialing || time.Now().Before(g.nextTrial) {
		return ErrUnavailable
	}
	g.trialing = true
	return nil
}

// recordReachable clears the breaker after any HTTP answer: a response proves
// the API is up, whatever its status.
func (g *Gemini) recordReachable() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.failures = 0
	g.healthy = true
	g.trialing = false
}

// recordFailure counts a call that exhausted its retries on transient errors;
// on the third in a row the breaker opens and trials are spaced by
// trialInterval.
func (g *Gemini) recordFailure() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.failures++
	if g.failures >= geminiMaxConsecutiveFailures {
		g.healthy = false
	}
	g.trialing = false
	g.nextTrial = time.Now().Add(g.trialInterval)
}

// clearTrial releases an admitted trial whose call never reached an outcome
// (caller cancelled while waiting for a concurrency slot).
func (g *Gemini) clearTrial() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.trialing = false
}

// complete sends one generateContent request with up to geminiMaxAttempts
// tries. Transport errors, timeouts, 429 and 5xx are retryable; other 4xx and
// unparseable responses return immediately.
func (g *Gemini) complete(ctx context.Context, body geminiRequest) (string, error) {
	if err := g.admit(); err != nil {
		return "", err
	}
	select {
	case g.sem <- struct{}{}:
		defer func() { <-g.sem }()
	case <-ctx.Done():
		g.clearTrial()
		return "", ctx.Err()
	}

	var lastErr error
	for attempt := 0; attempt < geminiMaxAttempts; attempt++ {
		content, retryable, err := g.request(ctx, body)
		switch {
		case err == nil:
			g.recordReachable()
			return content, nil
		case retryable:
			lastErr = err
		default:
			// Any HTTP answer proves reachability; cancellation does not.
			if ctx.Err() == nil {
				g.recordReachable()
			} else {
				g.clearTrial()
			}
			return "", err
		}
	}
	g.recordFailure()
	if !g.Healthy() {
		return "", ErrUnavailable
	}
	return "", lastErr
}

// request performs one generateContent attempt and reports whether the call
// may be retried.
func (g *Gemini) request(ctx context.Context, body geminiRequest) (content string, retryable bool, err error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return "", false, fmt.Errorf("gemini: encode request: %w", err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, g.timeout)
	defer cancel()
	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent", g.base, g.model)
	httpReq, err := http.NewRequestWithContext(requestCtx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return "", false, fmt.Errorf("gemini: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-goog-api-key", g.apiKey)
	resp, err := g.client.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return "", false, ctx.Err()
		}
		return "", true, fmt.Errorf("gemini: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return "", true, fmt.Errorf("gemini: read response: %w", err)
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		content, err := parseGeminiContent(data)
		return content, false, err
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return "", true, &RequestError{Status: resp.StatusCode, Message: errorMessage(data)}
	default:
		// Other 4xx rejections are request-level errors: logged, chunk skipped.
		return "", false, &RequestError{Status: resp.StatusCode, Message: errorMessage(data)}
	}
}

// buildRequest assembles the generateContent body: one content block whose
// parts carry the audio first (when given) and the prompt as text.
func (g *Gemini) buildRequest(audio *WAV, prompt string) geminiRequest {
	parts := []geminiPart{}
	if audio != nil {
		parts = append(parts, geminiPart{InlineData: &geminiInlineData{
			MimeType: "audio/wav",
			Data:     base64.StdEncoding.EncodeToString(audio.Data),
		}})
	}
	parts = append(parts, geminiPart{Text: prompt})
	return geminiRequest{
		Contents:         []geminiContent{{Parts: parts}},
		GenerationConfig: geminiGenerationConfig{Temperature: g.temperature, MaxOutputTokens: 256},
	}
}

// geminiRequest is the POST /v1beta/models/{model}:generateContent body.
type geminiRequest struct {
	Contents         []geminiContent        `json:"contents"`
	GenerationConfig geminiGenerationConfig `json:"generationConfig"`
}

type geminiContent struct {
	Parts []geminiPart `json:"parts"`
}

// geminiPart is one content part; which field is set depends on the kind:
// text or inlineData (base64 WAV).
type geminiPart struct {
	Text       string            `json:"text,omitempty"`
	InlineData *geminiInlineData `json:"inlineData,omitempty"`
}

type geminiInlineData struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type geminiGenerationConfig struct {
	Temperature     float64 `json:"temperature"`
	MaxOutputTokens int     `json:"maxOutputTokens"`
}

// geminiResponse is the subset of the generateContent response the provider
// reads: candidate text parts, finish reason and prompt blocking.
type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	PromptFeedback *struct {
		BlockReason string `json:"blockReason"`
	} `json:"promptFeedback"`
}

// parseGeminiContent extracts the candidate text from a 2xx response.
func parseGeminiContent(data []byte) (string, error) {
	var response geminiResponse
	if err := json.Unmarshal(data, &response); err != nil {
		return "", fmt.Errorf("gemini: invalid response: %w", err)
	}
	if len(response.Candidates) == 0 {
		if response.PromptFeedback != nil && response.PromptFeedback.BlockReason != "" {
			return "", fmt.Errorf("gemini: prompt blocked: %s", response.PromptFeedback.BlockReason)
		}
		return "", errors.New("gemini: response has no candidates")
	}
	candidate := response.Candidates[0]
	if candidate.FinishReason == "MAX_TOKENS" {
		return "", errors.New("gemini: model output truncated (finishReason: MAX_TOKENS)")
	}
	var text strings.Builder
	for _, part := range candidate.Content.Parts {
		text.WriteString(part.Text)
	}
	content := strings.TrimSpace(text.String())
	if content == "" {
		return "", errors.New("gemini: response has no text content")
	}
	return content, nil
}
