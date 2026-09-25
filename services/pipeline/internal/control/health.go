// Package control serves the pipeline's HTTP control surface.
package control

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/config"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/session"
)

// NewHandler exposes the health endpoint (no auth), the session control API
// (contract section 2, shared-secret bearer) and the ingest WebSocket route
// (contract section 4, ingest-token auth handled inside). Endpoint health
// probes land with the provider task; unprobed endpoints report unhealthy.
// registry and ingestWS may be nil, disabling their routes. ctx bounds the
// lifetime of runs started through the API — it is the server context.
func NewHandler(ctx context.Context, cfg config.Config, registry *session.Registry, ingestWS http.Handler) http.Handler {
	endpoints := make([]contract.EndpointHealth, 0)
	if cfg.Provider == "openai-compat" {
		for _, address := range cfg.InferenceURLs {
			endpoints = append(endpoints, contract.EndpointHealth{URL: address, Healthy: false})
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		response := contract.HealthResponse{
			Status:          "ok",
			ContractVersion: contract.Version,
			Provider:        cfg.Provider,
			Endpoints:       endpoints,
		}
		if registry != nil {
			response.ActiveSessions = registry.Active()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	})
	if registry != nil {
		(&sessionAPI{ctx: ctx, registry: registry, secret: cfg.SharedSecret}).register(mux)
	}
	if ingestWS != nil {
		mux.Handle("GET /v1/sessions/{sessionId}/ingest", ingestWS)
	}
	return mux
}
