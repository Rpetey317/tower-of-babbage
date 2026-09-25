# M1-12: pipeline control API

- `internal/control`: `GET /v1/sessions`, `POST /v1/sessions/{id}/start` and
  `POST /v1/sessions/{id}/stop` per contract section 2, mounted next to
  `/healthz` (still unauthenticated) and the ingest WebSocket (still
  token-authed). The three session routes enforce `Authorization: Bearer
  <SHARED_SECRET>` with a constant-time compare; missing or wrong
  credentials get `401 {"error":"unauthorized"}`.
- `start` strict-decodes the body, checks `contractVersion`
  (`400 contract_version_mismatch`), then delegates to `Registry.Start`.
  Responses: `202 {"runId":"…","status":"starting"}` (idempotent for the
  same runId), `409 {"error":"already_running","runId":<current>}`,
  `400 unsupported_language`, `400 invalid_source`. Runs receive the server
  lifetime context passed to `NewHandler`, never the request context, so a
  run outlives the POST that created it.
- `stop` accepts an optional `{"runId":"…"}` body, maps the registry's
  `ErrNotRunning` to `404 {"error":"not_running"}` and answers
  `202 {"runId":"…","status":"stopping"}`. `Registry.Stop` now returns the
  stopped run's id for that response.
- `Registry.Start` validates `sourceLanguage` and `targetLanguages` against
  `provider.LanguageName` before resolving the source, returning the new
  `UnsupportedLanguageError` (same pattern as `InvalidSourceError`). The
  check sits after the already-running early return so idempotent retries
  still short-circuit.
- `/healthz` now reports the real `activeSessions` count from the registry.
- Decisions: `invalid_source` doubles as the generic `400` for malformed
  bodies, empty `runId` and unknown `translationMode` — the contract's error
  enum is closed and adding a code would force a two-sided contract change.
  `Registry.Stop` stays synchronous (drains the queue before returning);
  the 202 response may arrive after the final `idle` status event.

Verification: `go test ./...` all green including the new
`internal/control` handler tests covering auth, list, start (202,
idempotent, 409 with runId, unsupported_language on source and target,
invalid_source on unknown type and missing replay file,
contract_version_mismatch, malformed body, bad translationMode) and stop
(202 with and without body, 404 not_running on missing session and wrong
runId). `go vet ./...` and `staticcheck ./...` (latest, 2025.1 cannot parse
this toolchain) clean.
