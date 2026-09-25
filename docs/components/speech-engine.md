# Speech engine

Location: `services/pipeline/internal/provider`.

Turns a chunk of audio into text in the source language and in each target
language. Everything model-specific lives behind one interface so that the
Gemini API (demo and MVP default), Gemma 4 on llama.cpp or vLLM (local path),
or a mock are interchangeable through configuration.

## Interface

```go
// SpeechProvider is implemented once per backend. Implementations are safe for
// concurrent use; the session runner limits in-flight calls.
type SpeechProvider interface {
    // Transcribe returns the transcript of a chunk in its source language.
    Transcribe(ctx context.Context, audio WAV, req TranscribeRequest) (Transcript, error)
    // TranscribeAndTranslate returns transcript and translation from one audio call
    // (Gemma 4 AST prompt). ok=false means the backend cannot do it in one call and
    // the runner must fall back to Transcribe + Translate.
    TranscribeAndTranslate(ctx context.Context, audio WAV, req ASTRequest) (ASTResult, bool, error)
    // Translate translates text between two languages.
    Translate(ctx context.Context, text string, req TranslateRequest) (string, error)
    // Healthy reports whether at least one endpoint is usable.
    Healthy() bool
}

type TranscribeRequest struct { SourceLanguage string; Glossary []GlossaryTerm }
type ASTRequest       struct { SourceLanguage, TargetLanguage string; Glossary []GlossaryTerm }
type TranslateRequest struct { SourceLanguage, TargetLanguage string; Glossary []GlossaryTerm }
type ASTResult        struct { Transcript, Translation string }
```

## Translation modes

Set per session (`translationMode` in the [contract](../contract.md)).

| Mode | Calls per chunk | When |
| --- | --- | --- |
| `ast` (default) | 1 audio call for the first target language; 1 text call per extra target | The AST prompt returns transcript and translation together, so the common case (one target) costs one audio call |
| `asr_then_text` | 1 audio call, then 1 text call per target | Providers without AST, or when AST output proves unreliable for a language pair |

If the AST output cannot be parsed the runner emits the transcript alone, logs
`provider_bad_output`, and performs a `Translate` call for that chunk.

## Provider: `gemini`

Demo and MVP provider. Speaks `generateContent` over REST:

```
POST https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent
x-goog-api-key: {GEMINI_API_KEY}

{ "contents": [{ "parts": [
  { "inlineData": { "mimeType": "audio/wav", "data": "<base64 wav>" } },
  { "text": "<prompt>" }
]}],
  "generationConfig": { "temperature": 0.2, "maxOutputTokens": 256 } }
```

The same ASR/AST/translate prompts are used; Gemini answers the AST format, so
the interface's `TranscribeAndTranslate` applies. `GEMINI_MODEL` selects the
model (default `gemini-2.5-flash`); `GEMINI_API_KEY` is required. In-flight
calls are bounded by `INFERENCE_MAX_CONCURRENCY` and `INFERENCE_TIMEOUT_SECONDS`;
`Healthy` reports whether the API is reachable. Later option: the Live API for
streaming transcription, which would bypass the chunker; the interface would
gain a streaming method at that point.

## Provider: `openai-compat` (local path)

Speaks `POST {base}/v1/chat/completions`. Works with llama.cpp `llama-server`
and vLLM; the only difference is the audio content block, chosen by
`INFERENCE_AUDIO_FORMAT`. Not used by the Gemini demo.

llama.cpp (`input_audio`, base64 WAV):

```json
{
  "model": "gemma-4",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "input_audio", "input_audio": { "data": "<base64 wav>", "format": "wav" } },
      { "type": "text", "text": "<prompt>" }
    ]
  }],
  "temperature": 0.2, "top_p": 0.95, "top_k": 64, "max_tokens": 256,
  "chat_template_kwargs": { "enable_thinking": false }
}
```

vLLM (`audio_url` with a data URI):

```json
{ "type": "audio_url", "audio_url": { "url": "data:audio/wav;base64,<base64 wav>" } }
```

Thinking mode must stay off: it adds latency and breaks output parsing.
Sampling defaults come from Google's Gemma 4 guidance except temperature,
lowered for transcription stability; `INFERENCE_TEMPERATURE` overrides it.

Endpoints and health:

- `INFERENCE_URLS` lists endpoints; requests round-robin across healthy ones
  with a per-endpoint semaphore of `INFERENCE_MAX_CONCURRENCY`.
- An endpoint becomes unhealthy after 3 consecutive transport errors or 5xx and
  is probed with `GET /health` every 5 s until it answers.
- One retry on another endpoint for timeouts and 5xx. No retry on 4xx; the
  chunk is logged and skipped.
- All endpoints unhealthy: `provider_unavailable`, session status `error`,
  chunks keep being dropped until recovery.

## Prompts

Language names are spelled out in English (`English`, `Spanish`, `Portuguese`).
The same prompt structures are sent to Gemini and to Gemma 4.

ASR (`Transcribe`):

```
Transcribe the following speech segment in {Source} into {Source} text.

Follow these specific instructions for formatting the answer:
* Only output the transcription, with no newlines.
* When transcribing numbers, write the digits, i.e. write 1.7 and not one point seven, and write 3 instead of three.
{glossary block}
```

AST (`TranscribeAndTranslate`):

```
Transcribe the following speech segment in {Source}, then translate it into {Target}.
When formatting the answer, first output the transcription in {Source}, then one newline, then output the string '{Target}: ', then the translation in {Target}.
{glossary block}
```

Parsing: split on the first line that starts with `{Target}:`; the part before
is the transcript, the remainder is the translation. Both are trimmed and
newlines collapsed to spaces.

Text translation (`Translate`):

```
Translate the following {Source} text into {Target}. Output only the translation, on one line.
{glossary block}

{text}
```

Glossary block (omitted when empty, capped at 40 terms, session terms before
global ones):

```
Technical terms and proper names that may appear. Spell them exactly as written: Kubernetes, gRPC, Nerdearla.
Translate these terms as indicated: pull request -> pull request; deployment -> despliegue.
```

Prompt text is defined in one Go file (`provider/prompts.go`) with table-driven
tests over sample outputs, including malformed ones.

## Provider: `mock`

No model. Returns deterministic text after `MOCK_LATENCY_MS` (default 300):

```
original:    "[mock en] chunk 12, 72.0s-78.4s"
translation: "[mock es] fragmento 12, 72.0s-78.4s"
```

If a file `<replay file stem>.mock.txt` exists next to a `file_replay` source, its
lines are used in order as transcripts instead, which makes demos readable.
Used by `make smoke`, UI development and multi-session load tests.

## Sizing

Per 6 s chunk: ~120 prompt tokens in, ~60-100 tokens out in `ast` mode. A
Gemini `generateContent` call takes roughly 1-4 s including the network round
trip; concurrency is bounded by the API rate limit rather than by hardware. On
the local path (Gemma 4 E2B on the RX 6600 with Vulkan) expect roughly 1-2.5 s
per call; a single llama-server with `--parallel 4` sustains one or two live
sessions. See [architecture.md](../architecture.md) for the latency budget
and [deployment.md](../deployment.md) for hardware.

## Verification

- `prompts_test.go`: prompt rendering with and without glossary; AST parsing of
  well-formed, missing-marker and multi-line outputs.
- `openaicompat_test.go`: `httptest` server asserting request shape for both
  audio formats, round-robin, unhealthy marking and retry.
- `gemini_test.go`: `httptest` server asserting the `generateContent` request
  shape, auth header, error mapping and timeout.
- Manual: `scripts/transcribe-file.sh fixtures/audio/en-kubernetes-60s.wav`
  prints transcript and translation for the first chunk against a local
  endpoint; a Gemini variant does the same against the API.
