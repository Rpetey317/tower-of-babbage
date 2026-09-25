// Package config parses and validates the pipeline's environment variables.
package config

import (
	"encoding/base64"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config contains all pipeline settings documented in docs/stack.md.
type Config struct {
	ListenAddr              string
	WebURL                  string
	SharedSecret            string
	Provider                string
	InferenceURLs           []string
	InferenceModel          string
	InferenceAudioFormat    string
	InferenceMaxConcurrency int
	InferenceTimeout        time.Duration
	InferenceTemperature    float64
	MockLatency             time.Duration
	GlossaryEnforce         bool
	ChunkTarget             time.Duration
	ChunkMax                time.Duration
	ChunkMin                time.Duration
	FixturesDir             string
	EventsFlush             time.Duration
	LogLevel                slog.Level
	GeminiAPIKey            string
	GeminiModel             string
}

// Load reads the process environment once at startup.
func Load() (Config, error) {
	return Parse(os.LookupEnv)
}

// Parse accepts a lookup function so configuration can be tested without
// changing the process environment.
func Parse(lookup func(string) (string, bool)) (Config, error) {
	value := func(name, fallback string) string {
		if supplied, ok := lookup(name); ok {
			return supplied
		}
		return fallback
	}
	config := Config{
		ListenAddr:           value("LISTEN_ADDR", ":8090"),
		WebURL:               value("WEB_URL", "http://localhost:3000"),
		SharedSecret:         value("SHARED_SECRET", ""),
		Provider:             value("PROVIDER", "openai-compat"),
		InferenceModel:       value("INFERENCE_MODEL", "gemma-4"),
		InferenceAudioFormat: value("INFERENCE_AUDIO_FORMAT", "input_audio"),
		FixturesDir:          value("FIXTURES_DIR", "../../fixtures/audio"),
		GeminiAPIKey:         value("GEMINI_API_KEY", ""),
		GeminiModel:          value("GEMINI_MODEL", "gemini-3.8-flash"),
	}

	if err := validateListenAddr(config.ListenAddr); err != nil {
		return Config{}, fmt.Errorf("LISTEN_ADDR: %w", err)
	}
	if err := validateHTTPURL(config.WebURL); err != nil {
		return Config{}, fmt.Errorf("WEB_URL: %w", err)
	}
	secret, err := base64.StdEncoding.Strict().DecodeString(config.SharedSecret)
	if err != nil || len(secret) < 32 {
		return Config{}, fmt.Errorf("SHARED_SECRET: must be base64-encoded with at least 32 bytes")
	}
	switch config.Provider {
	case "openai-compat", "mock", "gemini":
	default:
		return Config{}, fmt.Errorf("PROVIDER: unsupported value %q", config.Provider)
	}
	if config.Provider == "gemini" && config.GeminiAPIKey == "" {
		return Config{}, fmt.Errorf("GEMINI_API_KEY: required for the gemini provider")
	}
	if config.GeminiModel == "" {
		return Config{}, fmt.Errorf("GEMINI_MODEL: must not be empty")
	}
	for _, endpoint := range strings.Split(value("INFERENCE_URLS", "http://localhost:8080"), ",") {
		endpoint = strings.TrimSpace(endpoint)
		if err := validateHTTPURL(endpoint); err != nil {
			return Config{}, fmt.Errorf("INFERENCE_URLS: %w", err)
		}
		config.InferenceURLs = append(config.InferenceURLs, endpoint)
	}
	if config.InferenceModel == "" {
		return Config{}, fmt.Errorf("INFERENCE_MODEL: must not be empty")
	}
	if config.InferenceAudioFormat != "input_audio" && config.InferenceAudioFormat != "audio_url" {
		return Config{}, fmt.Errorf("INFERENCE_AUDIO_FORMAT: must be input_audio or audio_url")
	}
	if config.InferenceMaxConcurrency, err = positiveInt(value("INFERENCE_MAX_CONCURRENCY", "2")); err != nil {
		return Config{}, fmt.Errorf("INFERENCE_MAX_CONCURRENCY: %w", err)
	}
	if config.InferenceTimeout, err = positiveDuration(value("INFERENCE_TIMEOUT_SECONDS", "20"), time.Second); err != nil {
		return Config{}, fmt.Errorf("INFERENCE_TIMEOUT_SECONDS: %w", err)
	}
	if config.InferenceTemperature, err = strconv.ParseFloat(value("INFERENCE_TEMPERATURE", "0.2"), 64); err != nil || math.IsNaN(config.InferenceTemperature) || config.InferenceTemperature < 0 || config.InferenceTemperature > 2 {
		return Config{}, fmt.Errorf("INFERENCE_TEMPERATURE: must be a number between 0 and 2")
	}
	if config.MockLatency, err = nonnegativeDuration(value("MOCK_LATENCY_MS", "300"), time.Millisecond); err != nil {
		return Config{}, fmt.Errorf("MOCK_LATENCY_MS: %w", err)
	}
	if config.GlossaryEnforce, err = strconv.ParseBool(value("GLOSSARY_ENFORCE", "false")); err != nil {
		return Config{}, fmt.Errorf("GLOSSARY_ENFORCE: must be true or false")
	}
	if config.ChunkTarget, err = positiveDuration(value("CHUNK_TARGET_SECONDS", "6"), time.Second); err != nil {
		return Config{}, fmt.Errorf("CHUNK_TARGET_SECONDS: %w", err)
	}
	if config.ChunkMax, err = positiveDuration(value("CHUNK_MAX_SECONDS", "15"), time.Second); err != nil {
		return Config{}, fmt.Errorf("CHUNK_MAX_SECONDS: %w", err)
	}
	if config.ChunkMin, err = positiveDuration(value("CHUNK_MIN_SECONDS", "2"), time.Second); err != nil {
		return Config{}, fmt.Errorf("CHUNK_MIN_SECONDS: %w", err)
	}
	if config.ChunkMin > config.ChunkTarget || config.ChunkTarget > config.ChunkMax || config.ChunkMax > 30*time.Second {
		return Config{}, fmt.Errorf("CHUNK_*_SECONDS: require 0 < min <= target <= max <= 30")
	}
	if config.FixturesDir == "" {
		return Config{}, fmt.Errorf("FIXTURES_DIR: must not be empty")
	}
	if config.EventsFlush, err = positiveDuration(value("EVENTS_FLUSH_MS", "250"), time.Millisecond); err != nil {
		return Config{}, fmt.Errorf("EVENTS_FLUSH_MS: %w", err)
	}
	switch strings.ToLower(value("LOG_LEVEL", "info")) {
	case "debug":
		config.LogLevel = slog.LevelDebug
	case "info":
		config.LogLevel = slog.LevelInfo
	case "warn":
		config.LogLevel = slog.LevelWarn
	case "error":
		config.LogLevel = slog.LevelError
	default:
		return Config{}, fmt.Errorf("LOG_LEVEL: must be debug, info, warn, or error")
	}
	return config, nil
}

func validateListenAddr(address string) error {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("must be a host:port address: %w", err)
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	return nil
}

func validateHTTPURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return fmt.Errorf("must be an HTTP or HTTPS URL without credentials or a fragment")
	}
	return nil
}

func positiveInt(raw string) (int, error) {
	count, err := strconv.Atoi(raw)
	if err != nil || count <= 0 {
		return 0, fmt.Errorf("must be a positive integer")
	}
	return count, nil
}

func positiveDuration(raw string, unit time.Duration) (time.Duration, error) {
	count, err := positiveInt(raw)
	if err != nil || count > int((1<<63-1)/int64(unit)) {
		return 0, fmt.Errorf("must be a positive integer in range")
	}
	return time.Duration(count) * unit, nil
}

func nonnegativeDuration(raw string, unit time.Duration) (time.Duration, error) {
	count, err := strconv.Atoi(raw)
	if err != nil || count < 0 || count > int((1<<63-1)/int64(unit)) {
		return 0, fmt.Errorf("must be a nonnegative integer in range")
	}
	return time.Duration(count) * unit, nil
}
