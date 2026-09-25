package control

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/chunk"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/config"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/provider"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/session"
)

const testSecret = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="

// discardEvents satisfies session.Events for handler tests; the runner's
// events go nowhere.
type discardEvents struct{}

func (discardEvents) Segment(string, string, contract.SegmentEvent)        {}
func (discardEvents) Status(string, string, string, contract.SessionStats) {}
func (discardEvents) Log(string, string, string, string)                   {}
func (discardEvents) LogForRun(string, string, string, string, string, json.RawMessage) {
}
func (discardEvents) Flush(context.Context) {}

// testAPI builds a handler wired to a real registry so tests exercise the
// runner integration, not a stand-in. FIXTURES_DIR is an empty temp dir, so
// file_replay sources fail validation before ffmpeg is ever spawned.
func testAPI(t *testing.T) (http.Handler, *session.Registry) {
	t.Helper()
	registry := session.NewRegistry(session.Config{
		FixturesDir:    t.TempDir(),
		Chunk:          chunk.Config{Min: 400 * time.Millisecond, Target: 800 * time.Millisecond, Max: 3 * time.Second},
		StatusInterval: time.Hour,
		NoAudioAfter:   time.Hour,
	}, provider.NewMock(0, nil), discardEvents{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	handler := NewHandler(context.Background(), config.Config{
		Provider:     "mock",
		SharedSecret: testSecret,
	}, registry, nil)
	return handler, registry
}

func do(t *testing.T, handler http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = strings.NewReader(string(raw))
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("Authorization", "Bearer "+testSecret)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func startRequest(runID string) contract.SessionStartRequest {
	return contract.SessionStartRequest{
		ContractVersion: contract.Version,
		RunID:           runID,
		Slug:            "demo",
		SourceLanguage:  "en",
		TargetLanguages: []string{"es"},
		TranslationMode: "ast",
		Source:          contract.Source{Type: "browser_mic", Config: json.RawMessage(`{}`)},
		Glossary:        []contract.GlossaryTerm{},
	}
}

func decodeBody[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var payload T
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body is not JSON: %v: %q", err, response.Body.String())
	}
	return payload
}

func checkError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) contract.ControlError {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d (body %q)", response.Code, status, response.Body.String())
	}
	payload := decodeBody[contract.ControlError](t, response)
	if payload.Error != code {
		t.Fatalf("error = %q, want %q", payload.Error, code)
	}
	return payload
}

func TestSessionsRequireAuth(t *testing.T) {
	handler, _ := testAPI(t)
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/v1/sessions", nil),
		httptest.NewRequest(http.MethodPost, "/v1/sessions/s1/start", strings.NewReader(`{}`)),
		httptest.NewRequest(http.MethodPost, "/v1/sessions/s1/stop", nil),
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		checkError(t, response, http.StatusUnauthorized, "unauthorized")
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	request.Header.Set("Authorization", "Bearer wrong")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	checkError(t, response, http.StatusUnauthorized, "unauthorized")
}

func TestListSessionsEmpty(t *testing.T) {
	handler, _ := testAPI(t)
	response := do(t, handler, http.MethodGet, "/v1/sessions", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	payload := decodeBody[contract.SessionsResponse](t, response)
	if payload.Sessions == nil || len(payload.Sessions) != 0 {
		t.Fatalf("sessions = %v, want empty non-null array", payload.Sessions)
	}
}

func TestStartThenListAndStop(t *testing.T) {
	handler, registry := testAPI(t)
	sessionID := "1d953063-05b4-4cac-9249-58c8b1b326a1"

	response := do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", startRequest("5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77"))
	if response.Code != http.StatusAccepted {
		t.Fatalf("start status = %d (body %q)", response.Code, response.Body.String())
	}
	started := decodeBody[contract.SessionStartResponse](t, response)
	if started.RunID != "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77" || started.Status != "starting" {
		t.Fatalf("unexpected start response: %+v", started)
	}

	response = do(t, handler, http.MethodGet, "/v1/sessions", nil)
	listed := decodeBody[contract.SessionsResponse](t, response)
	if len(listed.Sessions) != 1 || listed.Sessions[0].SessionID != sessionID ||
		listed.Sessions[0].RunID != "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77" {
		t.Fatalf("unexpected sessions list: %+v", listed.Sessions)
	}

	response = do(t, handler, http.MethodGet, "/healthz", nil)
	health := decodeBody[contract.HealthResponse](t, response)
	if health.ActiveSessions != 1 {
		t.Fatalf("activeSessions = %d, want 1", health.ActiveSessions)
	}

	response = do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/stop", contract.SessionStopRequest{})
	stopped := decodeBody[contract.SessionStopResponse](t, response)
	if response.Code != http.StatusAccepted || stopped.RunID != "5c3b3b4e-1c1e-4a2e-9f0d-9a3f5b1e2d77" || stopped.Status != "stopping" {
		t.Fatalf("unexpected stop response: %d %+v", response.Code, stopped)
	}

	if active := registry.Active(); active != 0 {
		t.Fatalf("registry still holds %d runs after stop", active)
	}
}

func TestStartIdempotentForSameRun(t *testing.T) {
	handler, registry := testAPI(t)
	sessionID := "sess-idem"
	body := startRequest("run-1")

	for i := 0; i < 2; i++ {
		response := do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", body)
		if response.Code != http.StatusAccepted {
			t.Fatalf("start %d status = %d (body %q)", i, response.Code, response.Body.String())
		}
	}
	t.Cleanup(func() { _, _ = registry.Stop(sessionID, "") })
	if registry.Active() != 1 {
		t.Fatalf("expected exactly one run after repeated starts, got %d", registry.Active())
	}
}

func TestStartAlreadyRunning(t *testing.T) {
	handler, registry := testAPI(t)
	sessionID := "sess-conflict"
	t.Cleanup(func() { _, _ = registry.Stop(sessionID, "") })

	if response := do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", startRequest("run-1")); response.Code != http.StatusAccepted {
		t.Fatalf("first start failed: %d %q", response.Code, response.Body.String())
	}
	response := do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", startRequest("run-2"))
	payload := checkError(t, response, http.StatusConflict, "already_running")
	if payload.RunID == nil || *payload.RunID != "run-1" {
		t.Fatalf("expected current runId in 409, got %+v", payload)
	}
}

func TestStartUnsupportedLanguage(t *testing.T) {
	handler, _ := testAPI(t)
	sessionID := "sess-lang"

	bad := startRequest("run-1")
	bad.SourceLanguage = "xx"
	checkError(t, do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", bad), http.StatusBadRequest, "unsupported_language")

	bad = startRequest("run-1")
	bad.TargetLanguages = []string{"es", "zz"}
	checkError(t, do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", bad), http.StatusBadRequest, "unsupported_language")
}

func TestStartInvalidSource(t *testing.T) {
	handler, _ := testAPI(t)
	sessionID := "sess-source"

	bad := startRequest("run-1")
	bad.Source = contract.Source{Type: "stream_url", Config: json.RawMessage(`{}`)}
	checkError(t, do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", bad), http.StatusBadRequest, "invalid_source")

	bad = startRequest("run-1")
	bad.Source = contract.Source{Type: "file_replay", Config: json.RawMessage(`{"path":"missing.wav","loop":false}`)}
	checkError(t, do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", bad), http.StatusBadRequest, "invalid_source")
}

func TestStartContractVersionMismatch(t *testing.T) {
	handler, _ := testAPI(t)
	bad := startRequest("run-1")
	bad.ContractVersion = 99
	checkError(t, do(t, handler, http.MethodPost, "/v1/sessions/s1/start", bad), http.StatusBadRequest, "contract_version_mismatch")
}

func TestStartBadRequestBody(t *testing.T) {
	handler, _ := testAPI(t)

	request := httptest.NewRequest(http.MethodPost, "/v1/sessions/s1/start", strings.NewReader(`{"runId":`))
	request.Header.Set("Authorization", "Bearer "+testSecret)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	checkError(t, response, http.StatusBadRequest, "invalid_source")

	bad := startRequest("run-1")
	bad.TranslationMode = "wat"
	checkError(t, do(t, handler, http.MethodPost, "/v1/sessions/s1/start", bad), http.StatusBadRequest, "invalid_source")
}

func TestStopNotRunning(t *testing.T) {
	handler, registry := testAPI(t)
	sessionID := "sess-stop"

	checkError(t, do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/stop", nil), http.StatusNotFound, "not_running")

	if response := do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", startRequest("run-1")); response.Code != http.StatusAccepted {
		t.Fatalf("start failed: %d %q", response.Code, response.Body.String())
	}
	t.Cleanup(func() { _, _ = registry.Stop(sessionID, "") })

	other := "somebody-else"
	checkError(t, do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/stop", contract.SessionStopRequest{RunID: &other}), http.StatusNotFound, "not_running")
}
