# Glossary

Location: `apps/web/src/app/admin/glossary`, session editor in
`apps/web/src/app/admin/sessions/[id]`, prompt injection in
`services/pipeline/internal/provider/prompts.go`.

Conference talks are full of product names, acronyms and people. Small models
misspell them and translate what should stay untranslated. The glossary gives
the model a short list of terms per session.

## Model

`glossary_terms` from the [domain model](../domain-model.md): `term`,
optional `translation`, optional `notes`, `sessionId` or `null` for global.

| `translation` | Meaning in the prompt |
| --- | --- |
| `null` | Spell exactly as written and keep untranslated |
| same as `term` | Same as above, explicit |
| other text | Translate the term as indicated |

## Flow

1. Admin edits global terms (`/admin/glossary`) and per-session terms
   (session page). Bulk paste is supported: one term per line, optional
   `term = translation`.
2. `admin.sessions.start` merges session terms followed by global terms,
   deduplicates by lowercase `term`, keeps the first 40 and sends them in the
   start request.
3. The pipeline renders the glossary block into every prompt of the run
   (see [speech-engine.md](speech-engine.md)).
4. While running, edits call `PUT /v1/sessions/{id}/glossary`, which replaces
   the active list for subsequent chunks.

The cap of 40 keeps prompt evaluation cheap; prompt tokens are paid on every
chunk. Terms are ordered session first, then global, so the most specific ones
survive the cap.

## Post-processing (optional, off by default)

`GLOSSARY_ENFORCE=true` makes the pipeline post-process provider output with
`provider.EnforceGlossary` (`services/pipeline/internal/provider/enforce.go`):
case-insensitive, whole-word replacement of each `term` in transcripts with
its canonical spelling, and of each `term` in translations with its
`translation` (a `null` or empty translation keeps the canonical term).
Letters, digits and `_` count as word characters, so `kubectlx` or
`my_kubectl` stay untouched. Useful when the model keeps mangling a name;
risky for short terms, hence off by default.

## Measured results (M4-03)

Replayed `fixtures/audio/en-glossary-30s.wav` (says `kubectl`, `etcd`,
`Nerdearla` several times each) through the Gemini provider with
`scripts/glossary-quality.mjs`; full numbers in issue #33.

| Glossary | WER | Effect |
| --- | --- | --- |
| none | 8.57% | `etcd` → "it could"/"it", `Nerdearla` → "Nerdio" |
| terms in prompt | 1.43% | every term spelled correctly |
| prompt + `GLOSSARY_ENFORCE` | 1.43% | identical output |

The prompt block alone fixed every misspelling, so `GLOSSARY_ENFORCE`
stays off by default: the failures it can repair (case variants) never
occurred, and word-swap replacements stay risky for short terms. An
absent-term glossary on `en-kubernetes-60s.wav` changed nothing (0.66%
WER both ways, no leaked terms) but roughly doubled segment latency —
prompt tokens are paid on every chunk, which is why the cap exists.

## Verification

- Vitest: merge, dedupe and cap logic in `admin.sessions.start`.
- Go: prompt rendering with an empty list, one untranslated term, one translated
  term, and 60 terms (capped at 40); `PUT /v1/sessions/{id}/glossary` handler
  tests; runner test showing the next chunk's provider call uses the new list;
  `EnforceGlossary` table tests for whole-word behaviour.
- Manual: `node scripts/glossary-quality.mjs` replays the fixtures with and
  without the glossary and writes transcripts plus a WER report
  (`en-glossary-30s.wav` exercises `kubectl`, `etcd`, `Nerdearla`).
