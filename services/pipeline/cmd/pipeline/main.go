package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/config"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/control"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/ingest"
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
	// The ingest endpoint is live but reports 4004 until the session runner
	// (M1-11) supplies a Sessions registry.
	ingestWS := ingest.NewHandler(nil, cfg.SharedSecret, nil, logger)
	server := &http.Server{Handler: control.NewHandler(cfg, ingestWS), ReadHeaderTimeout: 5 * time.Second}
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
		logger.Info("pipeline stopped")
		return nil
	}
}
