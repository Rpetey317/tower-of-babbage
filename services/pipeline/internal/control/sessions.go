package control

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/contract"
	"github.com/Rpetey317/tower-of-babbage/services/pipeline/internal/session"
)

// sessionAPI serves the authenticated session routes from contract section
// 2. ctx is the server lifetime context: runs started here must outlive the
// HTTP request that created them, so the request context is never used.
type sessionAPI struct {
	ctx      context.Context
	registry *session.Registry
	secret   string
}

func (a *sessionAPI) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/sessions", a.withAuth(a.list))
	mux.HandleFunc("POST /v1/sessions/{sessionId}/start", a.withAuth(a.start))
	mux.HandleFunc("POST /v1/sessions/{sessionId}/stop", a.withAuth(a.stop))
	mux.HandleFunc("PUT /v1/sessions/{sessionId}/glossary", a.withAuth(a.glossary))
}

// withAuth enforces the shared-secret bearer from contract section 1.
func (a *sessionAPI) withAuth(next http.HandlerFunc) http.HandlerFunc {
	expected := "Bearer " + a.secret
	return func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if subtle.ConstantTimeCompare([]byte(header), []byte(expected)) != 1 {
			writeControlError(w, http.StatusUnauthorized, "unauthorized", "")
			return
		}
		next(w, r)
	}
}

func (a *sessionAPI) list(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, contract.SessionsResponse{Sessions: a.registry.Sessions()})
}

func (a *sessionAPI) start(w http.ResponseWriter, r *http.Request) {
	var req contract.SessionStartRequest
	if err := decodeJSON(r, &req); err != nil {
		writeControlError(w, http.StatusBadRequest, "invalid_source", "")
		return
	}
	if req.ContractVersion != contract.Version {
		writeControlError(w, http.StatusBadRequest, "contract_version_mismatch", "")
		return
	}
	// invalid_source is the contract's generic 400 for bad configuration;
	// the error enum is closed, so no dedicated code exists for these.
	if req.RunID == "" || (req.TranslationMode != "ast" && req.TranslationMode != "asr_then_text") {
		writeControlError(w, http.StatusBadRequest, "invalid_source", "")
		return
	}
	_, err := a.registry.Start(a.ctx, r.PathValue("sessionId"), req)
	var already *session.AlreadyRunningError
	var badLanguage *session.UnsupportedLanguageError
	var badSource *session.InvalidSourceError
	switch {
	case err == nil:
		writeJSON(w, http.StatusAccepted, contract.SessionStartResponse{RunID: req.RunID, Status: "starting"})
	case errors.As(err, &already):
		writeControlError(w, http.StatusConflict, "already_running", already.RunID)
	case errors.As(err, &badLanguage):
		writeControlError(w, http.StatusBadRequest, "unsupported_language", "")
	case errors.As(err, &badSource):
		writeControlError(w, http.StatusBadRequest, "invalid_source", "")
	default:
		writeControlError(w, http.StatusInternalServerError, "internal_error", "")
	}
}

func (a *sessionAPI) stop(w http.ResponseWriter, r *http.Request) {
	var req contract.SessionStopRequest
	switch err := decodeJSON(r, &req); {
	case errors.Is(err, io.EOF):
		// The body is optional: an empty one stops whatever run is active.
	case err != nil:
		writeControlError(w, http.StatusBadRequest, "invalid_source", "")
		return
	}
	runID := ""
	if req.RunID != nil {
		runID = *req.RunID
	}
	stopped, err := a.registry.Stop(r.PathValue("sessionId"), runID)
	switch {
	case errors.Is(err, session.ErrNotRunning):
		writeControlError(w, http.StatusNotFound, "not_running", "")
	case err != nil:
		writeControlError(w, http.StatusInternalServerError, "internal_error", "")
	default:
		writeJSON(w, http.StatusAccepted, contract.SessionStopResponse{RunID: stopped, Status: "stopping"})
	}
}

// glossary replaces the active run's glossary for later chunks (contract
// section 2). The error enum is closed, so a malformed body reuses
// invalid_source, the generic 400.
func (a *sessionAPI) glossary(w http.ResponseWriter, r *http.Request) {
	var req contract.GlossaryUpdateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeControlError(w, http.StatusBadRequest, "invalid_source", "")
		return
	}
	count, err := a.registry.UpdateGlossary(r.PathValue("sessionId"), req.Glossary)
	switch {
	case errors.Is(err, session.ErrNotRunning):
		writeControlError(w, http.StatusNotFound, "not_running", "")
	case err != nil:
		writeControlError(w, http.StatusInternalServerError, "internal_error", "")
	default:
		writeJSON(w, http.StatusOK, contract.GlossaryUpdateResponse{Count: count})
	}
}

// decodeJSON applies the contract's strict-field convention to request bodies.
func decodeJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeControlError(w http.ResponseWriter, status int, code, runID string) {
	payload := contract.ControlError{Error: code}
	if runID != "" {
		payload.RunID = &runID
	}
	writeJSON(w, status, payload)
}
