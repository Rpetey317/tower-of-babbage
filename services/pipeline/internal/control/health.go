// Package control serves the pipeline's HTTP control surface.
package control

import (
	"encoding/json"
	"net/http"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/config"
)

const contractVersion = 1

type endpoint struct {
	URL     string `json:"url"`
	Healthy bool   `json:"healthy"`
}

type healthResponse struct {
	Status          string     `json:"status"`
	ContractVersion int        `json:"contractVersion"`
	Provider        string     `json:"provider"`
	Endpoints       []endpoint `json:"endpoints"`
	ActiveSessions  int        `json:"activeSessions"`
}

// NewHandler exposes the M0 health endpoint. Provider probes and session counts
// are added when those components exist; unprobed endpoints report unhealthy.
func NewHandler(cfg config.Config) http.Handler {
	endpoints := make([]endpoint, 0)
	if cfg.Provider == "openai-compat" {
		for _, address := range cfg.InferenceURLs {
			endpoints = append(endpoints, endpoint{URL: address, Healthy: false})
		}
	}
	response := healthResponse{
		Status:          "ok",
		ContractVersion: contractVersion,
		Provider:        cfg.Provider,
		Endpoints:       endpoints,
		ActiveSessions:  0,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	})
	return mux
}
