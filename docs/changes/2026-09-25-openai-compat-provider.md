# OpenAI-compatible speech provider (M1-10)

Added `OpenAICompat` in `services/pipeline/internal/provider`, implementing
`SpeechProvider` against `POST {endpoint}/v1/chat/completions` (llama.cpp
llama-server and vLLM, the local inference path).

- `NewOpenAICompat(OpenAICompatConfig)` takes the `INFERENCE_*` settings
  (URLs, model, audio format, per-endpoint concurrency, timeout, temperature);
  `top_p` 0.95, `top_k` 64, `max_tokens` 256 and
  `chat_template_kwargs.enable_thinking=false` are fixed.
- Request building covers both `input_audio` (base64 WAV, llama.cpp) and
  `audio_url` (data-URI, vLLM); `Translate` sends a text-only message.
- Calls round-robin across healthy endpoints, each with a semaphore of
  `INFERENCE_MAX_CONCURRENCY`; when all healthy endpoints are full the call
  waits on the first one.
- An endpoint goes unhealthy after 3 consecutive transport errors or 5xx and
  is probed with `GET /health` every 5 s until it answers; `Close` stops the
  probers. `Healthy()` reports whether any endpoint is usable.
- One retry on a different endpoint for timeouts, transport errors and 5xx;
  no retry on 4xx (`RequestError`, the chunk is logged and skipped).
  `finish_reason=length` and empty/invalid responses are errors.
- Unparseable AST output returns `ok=false` with `ErrBadOutput` and keeps the
  raw output as the transcript so the runner can emit it and redo the
  translation with a text call. All-endpoints-down reports `ErrUnavailable`
  (runner maps it to `provider_unavailable`).

Not wired into `cmd/pipeline` yet; the session runner (M1-11) owns provider
construction from `internal/config`.

Verification: `go test ./internal/provider/ -race` — request bodies asserted
for both audio formats, AST and translate flows, retry on 5xx, no retry on
4xx (and 4xx not counted toward health), unhealthy marking after 3 failures
plus recovery after the `/health` probe, round-robin across two endpoints,
the per-endpoint semaphore bound, bad-output fallback and truncated-output
rejection. `go vet` and `staticcheck` clean.
