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

`GLOSSARY_ENFORCE=true` makes the pipeline apply case-insensitive, whole-word
replacement of each `term` in transcripts with its canonical spelling, and of
each translated term in translations. Useful when the model keeps mangling a
name; risky for short terms, hence off by default. Not planned for M4 unless
prompting alone proves insufficient during testing.

## Verification

- Vitest: merge, dedupe and cap logic in `admin.sessions.start`.
- Go: prompt rendering with an empty list, one untranslated term, one translated
  term, and 60 terms (capped at 40).
- Manual: replay `fixtures/audio/en-kubernetes-60s.wav` with and without a
  glossary containing `kubectl`, `etcd`, `Nerdearla`; compare spellings in the
  exported TXT.
