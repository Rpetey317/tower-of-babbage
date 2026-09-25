package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/config"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/control"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/emit"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/ingest"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/provider"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/session"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := serve(ctx, cfg, logger); err != nil {
		logger.Error("pipeline stopped", "error", err)
		os.Exit(1)
	}
}

// serve owns the listener and waits for all HTTP requests to finish on shutdown.
func serve(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}
	speech, err := buildProvider(cfg)
	if err != nil {
		return err
	}
	events := emit.NewClient(emit.Config{
		WebURL:       cfg.WebURL,
		SharedSecret: cfg.SharedSecret,
		Flush:        cfg.EventsFlush,
	}, logger)
	registry := session.NewRegistry(session.Config{
		FixturesDir:    cfg.FixturesDir,
		Chunk:          chunk.Config{Min: cfg.ChunkMin, Target: cfg.ChunkTarget, Max: cfg.ChunkMax},
		MaxConcurrency: cfg.InferenceMaxConcurrency,
	}, speech, events, logger)
	ingestWS := ingest.NewHandler(registry, cfg.SharedSecret, events, logger)
	server := &http.Server{Handler: control.NewHandler(ctx, cfg, registry, ingestWS), ReadHeaderTimeout: 5 * time.Second}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	logger.Info("pipeline listening", "address", listener.Addr().String(), "provider", cfg.Provider)
	select {
	case err := <-serveDone:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			<-serveDone
			return err
		}
		if err := <-serveDone; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		events.Close()
		logger.Info("pipeline stopped")
		return nil
	}
}

// buildProvider picks the SpeechProvider from PROVIDER. The gemini provider
// lands with M1-16; until then it fails fast at startup.
func buildProvider(cfg config.Config) (provider.SpeechProvider, error) {
	switch cfg.Provider {
	case "mock":
		return provider.NewMock(cfg.MockLatency, nil), nil
	case "openai-compat":
		return provider.NewOpenAICompat(provider.OpenAICompatConfig{
			URLs:           cfg.InferenceURLs,
			Model:          cfg.InferenceModel,
			AudioFormat:    cfg.InferenceAudioFormat,
			MaxConcurrency: cfg.InferenceMaxConcurrency,
			Timeout:        cfg.InferenceTimeout,
			Temperature:    cfg.InferenceTemperature,
		})
	default:
		return nil, fmt.Errorf("provider %q is not implemented yet", cfg.Provider)
	}
}
