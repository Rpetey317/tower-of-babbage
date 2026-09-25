package config

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

const testSecret = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="

func parseValues(values map[string]string) (Config, error) {
	return Parse(func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	})
}

func TestDefaults(t *testing.T) {
	cfg, err := parseValues(map[string]string{"SHARED_SECRET": testSecret})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != ":8090" || cfg.Provider != "openai-compat" || cfg.WebURL != "http://localhost:3000" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if len(cfg.InferenceURLs) != 1 || cfg.InferenceURLs[0] != "http://localhost:8080" {
		t.Fatalf("unexpected inference URLs: %v", cfg.InferenceURLs)
	}
	if cfg.GeminiModel != "gemini-3.8-flash" {
		t.Fatalf("unexpected default Gemini model: %q", cfg.GeminiModel)
	}
	if cfg.ChunkMin != 2*time.Second || cfg.ChunkTarget != 6*time.Second || cfg.ChunkMax != 15*time.Second {
		t.Fatalf("unexpected chunk durations: %+v", cfg)
	}
}

func TestOverrides(t *testing.T) {
	cfg, err := parseValues(map[string]string{
		"SHARED_SECRET":     testSecret,
		"PROVIDER":          "mock",
		"INFERENCE_URLS":    "https://one.example, http://two.example",
		"MOCK_LATENCY_MS":   "0",
		"GLOSSARY_ENFORCE":  "true",
		"CHUNK_MAX_SECONDS": "30",
		"LOG_LEVEL":         "debug",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Provider != "mock" || cfg.InferenceURLs[1] != "http://two.example" || cfg.MockLatency != 0 || !cfg.GlossaryEnforce || cfg.ChunkMax != 30*time.Second || cfg.LogLevel.String() != "DEBUG" {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
}

func TestInvalidSettings(t *testing.T) {
	tests := []struct {
		name, value string
	}{
		{"LISTEN_ADDR", "localhost"},
		{"WEB_URL", "file:///tmp/web"},
		{"SHARED_SECRET", base64.StdEncoding.EncodeToString([]byte("short"))},
		{"PROVIDER", "unknown"},
		{"INFERENCE_URLS", "http://valid.example,not-a-url"},
		{"INFERENCE_MODEL", ""},
		{"INFERENCE_AUDIO_FORMAT", "raw"},
		{"INFERENCE_MAX_CONCURRENCY", "0"},
		{"INFERENCE_TIMEOUT_SECONDS", "-1"},
		{"INFERENCE_TEMPERATURE", "NaN"},
		{"MOCK_LATENCY_MS", "-1"},
		{"GLOSSARY_ENFORCE", "sometimes"},
		{"CHUNK_TARGET_SECONDS", "16"},
		{"CHUNK_MAX_SECONDS", "31"},
		{"CHUNK_MIN_SECONDS", "7"},
		{"FIXTURES_DIR", ""},
		{"GEMINI_MODEL", ""},
		{"EVENTS_FLUSH_MS", "0"},
		{"LOG_LEVEL", "trace"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseValues(map[string]string{"SHARED_SECRET": testSecret, test.name: test.value})
			want := test.name
			if strings.HasPrefix(want, "CHUNK_") {
				want = "CHUNK_*_SECONDS"
			}
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("expected %s error, got %v", test.name, err)
			}
		})
	}
}

func TestRequiredProviderCredentials(t *testing.T) {
	_, err := parseValues(map[string]string{"SHARED_SECRET": testSecret, "PROVIDER": "gemini"})
	if err == nil || !strings.Contains(err.Error(), "GEMINI_API_KEY") {
		t.Fatalf("expected Gemini key error, got %v", err)
	}
	if _, err := parseValues(map[string]string{"SHARED_SECRET": testSecret, "PROVIDER": "gemini", "GEMINI_API_KEY": "test-key"}); err != nil {
		t.Fatal(err)
	}
	if _, err := parseValues(nil); err == nil || !strings.Contains(err.Error(), "SHARED_SECRET") {
		t.Fatalf("expected missing secret error, got %v", err)
	}
}
