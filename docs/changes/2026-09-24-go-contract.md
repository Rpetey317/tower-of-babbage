# M0-06: Go contract messages and ingest token verification

Added typed Go messages for the control API, events API, and ingest WebSocket.
The pipeline health endpoint now uses the shared response type. Fixture tests
round-trip every shared message fixture and distinguish segment, status, and log
events. Ingest token verification checks the HMAC with the decoded shared secret,
canonical encoding, expiry, and session binding against the shared vector.

Verification: `make test`, `make lint`, and `go test ./internal/contract/...` from
`services/pipeline`. No GPU or model is needed for these checks.
