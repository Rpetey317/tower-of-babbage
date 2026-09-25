# M1-16: Gemini speech provider

- `internal/provider/gemini.go`: `SpeechProvider` speaking
  `POST /v1beta/models/{GEMINI_MODEL}:generateContent` with the chunk WAV as
  base64 `inlineData` (`audio/wav`) and `GEMINI_API_KEY` in `x-goog-api-key`.
  Implements `Transcribe`, `TranscribeAndTranslate` (shared AST prompt) and
  `Translate` (text-only call). Concurrency bounded by
  `INFERENCE_MAX_CONCURRENCY`, per-attempt timeout by
  `INFERENCE_TIMEOUT_SECONDS`.
- Failures: one retry on transport errors, timeouts, 429 and 5xx; other 4xx
  return `RequestError` without retry. Three consecutive exhausted calls open
  a breaker that fails fast with `ErrUnavailable` and admits one half-open
  trial every 5 s until any HTTP answer restores `Healthy`.
- `ErrUnavailable`, `ErrBadOutput` and `RequestError` moved to `provider.go`
  with neutral messages so both providers share them.
- Config: `GEMINI_MODEL` (default `gemini-2.5-flash`, empty rejected);
  `PROVIDER=gemini` wired in `cmd/pipeline/main.go`.
- `scripts/transcribe-file-gemini.sh`: Gemini variant of `transcribe-file.sh`;
  sends a 10 s WAV chunk and prints raw output, transcript, translation and
  request time.
- Verification: `gemini_test.go` (`httptest`: request shape, auth header,
  AST parsing, `ErrBadOutput`, retry/4xx mapping, breaker open/recover, block
  reason, MAX_TOKENS, timeout), `config_test.go` for `GEMINI_MODEL`; `go test
  ./...`, `go vet`, `staticcheck`, `go build` clean; `/healthz` reports
  `provider: "gemini"` on boot.
- Pending: the live call against `fixtures/audio/en-kubernetes-60s.wav`. The
  `GEMINI_API_KEY` in `services/pipeline/.env` gets HTTP 402
  ("prepayment credits are depleted") on every current model and HTTP 404 on
  the retired 2.5 generation — needs a funded key to complete the issue's
  real-call criterion.
