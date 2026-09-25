# Session glossary update (M4-02)

`PUT /v1/sessions/{id}/glossary` (contract section 2) plus the optional
`GLOSSARY_ENFORCE` post-replacement. Closes the gap M4-01 noted: the web app
already pushed merged glossaries to this endpoint and swallowed the 404.

- `control/sessions.go`: new authed route; decodes
  `contract.GlossaryUpdateRequest` (strict fields, `400 invalid_source` on a
  bad body), `404 not_running` when the session has no active run, else
  `200 {"count": n}`.
- `session/registry.go`: `UpdateGlossary` resolves the active runner;
  `Config` gains `GlossaryEnforce` (wired from the existing
  `config.Config.GlossaryEnforce` in `main.go`).
- `session/runner.go`: the glossary moved off `req.Glossary` into an
  `atomic.Value`; provider calls read the live list, so a replacement applies
  from the next chunk on. When `GlossaryEnforce` is on, transcripts and
  translations go through `provider.EnforceGlossary`.
- `provider/enforce.go`: `EnforceGlossary` — case-insensitive, whole-word
  replacement (letters, digits, `_` are word chars). Transcripts get the
  canonical spelling of each term; translations get `term -> translation`
  (canonical term when `translation` is null or empty). Terms apply in list
  order, so session terms win ties over global ones.

Drive-by fix: `Runner.run` parked in its select never observed `stopCh` until
a result or heartbeat arrived, so `Stop`/`Shutdown` could block up to
`StatusInterval` (1 h in the control tests, which hung intermittently —
reproduced on main with `-count=5`). The loop now selects on `stopCh` once
and disables the case afterwards so drain iterations do not spin.

Verification:

- `go test -count=1 ./...` in `services/pipeline`: all packages pass,
  including the new `TestGlossaryUpdate` (200 count, 404 not_running, 400 on
  unknown field, 401 unauthenticated), `TestGlossaryUpdateAppliesToNextChunk`
  (provider sees the old list, then the new one) and the `EnforceGlossary`
  table tests (canonical spelling, word boundaries, multi-word terms,
  translated terms, empty inputs).
- `go test -race -count=1 ./internal/control ./internal/session
  ./internal/provider`: clean.
- `go vet ./...` and `staticcheck ./...`: clean.
