# Speech provider interface and mock (M1-09)

Added `services/pipeline/internal/provider`: the `SpeechProvider` interface
(`Transcribe`, `TranscribeAndTranslate`, `Translate`, `Healthy`) and the `WAV`,
request and result types the session runner will consume. `prompts.go` renders
the ASR, AST and text-translation prompts with the glossary block (terms
without a translation listed for exact spelling, translated terms as
`term -> translation`, capped at 40 entries keeping session-before-global
order) and `languages.go` maps BCP 47 codes to English names. `ast.go` parses
AST output on the first `{Target}:` line, collapsing newlines to spaces and
rejecting missing markers or empty halves. `mock.go` is the deterministic
provider: fixed `[mock <lang>] chunk/fragmento <i>, <start>s-<end>s` text after
`MOCK_LATENCY_MS`, or successive `.mock.txt` lines loaded with `LoadMockLines`,
cycling for `loop` replays.

Verification: `go test ./internal/provider/` — table-driven prompt rendering,
AST parsing (well-formed, multi-line, missing marker, wrong language), the
60-term glossary cap, deterministic mock output and concurrency; `go vet` and
`staticcheck` clean.
