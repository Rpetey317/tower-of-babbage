package control

import (
	"net/http"
	"testing"
)

// M6-01 acceptance: a start request naming languages in the provider table
// but not exercised by the demo (pt -> es) is accepted. Rejection of unknown
// codes is covered by TestStartUnsupportedLanguage in sessions_test.go.
func TestStartPortugueseToSpanish(t *testing.T) {
	handler, registry := testAPI(t)
	sessionID := "sess-pt"

	req := startRequest("run-pt")
	req.SourceLanguage = "pt"
	req.TargetLanguages = []string{"es"}
	response := do(t, handler, http.MethodPost, "/v1/sessions/"+sessionID+"/start", req)
	if response.Code != http.StatusAccepted {
		t.Fatalf("pt -> es start status = %d (body %q)", response.Code, response.Body.String())
	}
	t.Cleanup(func() { _, _ = registry.Stop(sessionID, "") })
}
