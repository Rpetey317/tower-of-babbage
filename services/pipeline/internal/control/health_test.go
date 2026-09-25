package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/config"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
)

func TestHealth(t *testing.T) {
	for _, test := range []struct {
		name      string
		config    config.Config
		endpoints int
	}{
		{"mock", config.Config{Provider: "mock"}, 0},
		{"openai", config.Config{Provider: "openai-compat", InferenceURLs: []string{"http://one:8080", "http://two:8080"}}, 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
			response := httptest.NewRecorder()
			NewHandler(context.Background(), test.config, nil, nil).ServeHTTP(response, request)
			if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("unexpected response: %d %v", response.Code, response.Header())
			}
			var payload contract.HealthResponse
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if payload.Status != "ok" || payload.ContractVersion != contract.Version || payload.Provider != test.config.Provider || payload.ActiveSessions != 0 || len(payload.Endpoints) != test.endpoints {
				t.Fatalf("unexpected payload: %+v", payload)
			}
			for _, endpoint := range payload.Endpoints {
				if endpoint.Healthy {
					t.Fatalf("unprobed endpoint reported healthy: %+v", endpoint)
				}
			}
		})
	}
}

func TestHealthRejectsOtherRoutes(t *testing.T) {
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodPost, "/healthz", nil),
		httptest.NewRequest(http.MethodGet, "/nope", nil),
	} {
		response := httptest.NewRecorder()
		NewHandler(context.Background(), config.Config{Provider: "mock"}, nil, nil).ServeHTTP(response, request)
		if response.Code < 400 {
			t.Fatalf("%s %s returned %d", request.Method, request.URL.Path, response.Code)
		}
	}
}
