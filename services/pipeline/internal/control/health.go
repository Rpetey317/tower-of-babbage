// Package control serves the pipeline's HTTP control surface.
package control

import (
	"encoding/json"
	"net/http"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/config"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

// NewHandler exposes the M0 health endpoint plus the ingest WebSocket route
// (contract section 4). Provider probes and session counts are added when
// those components exist; unprobed endpoints report unhealthy. ingestWS may be
// nil while no session registry exists.
func NewHandler(cfg config.Config, ingestWS http.Handler) http.Handler {
	endpoints := make([]contract.EndpointHealth, 0)
	if cfg.Provider == "openai-compat" {
		for _, address := range cfg.InferenceURLs {
			endpoints = append(endpoints, contract.EndpointHealth{URL: address, Healthy: false})
		}
	}
	response := contract.HealthResponse{
		Status:          "ok",
		ContractVersion: contract.Version,
		Provider:        cfg.Provider,
		Endpoints:       endpoints,
		ActiveSessions:  0,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	})
	if ingestWS != nil {
		mux.Handle("GET /v1/sessions/{sessionId}/ingest", ingestWS)
	}
	return mux
}
