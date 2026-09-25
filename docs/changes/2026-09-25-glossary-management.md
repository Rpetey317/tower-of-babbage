# Glossary management (M4-01)

Glossary CRUD for global and session scope per
`docs/components/glossary.md` and `docs/components/admin-panel.md`.

- `lib/admin/glossary.ts`: `mergeGlossary(sessionTerms, globalTerms)`
  (session-first order, case-insensitive dedupe on `term`, cap at
  `GLOSSARY_CAP = 40`) and `parseBulkPaste` (`term = translation` per line,
  blank lines and in-paste duplicates skipped).
- `admin` router: `mergedGlossary` now applies the dedupe/cap; new
  `glossary` sub-router — `list({ sessionId? })` per scope, `upsert`
  (by `id`, or by same-scope term match to avoid duplicates), `addMany`
  (bulk paste, existing terms skipped, returns `{ added, skipped }`),
  `delete`. Mutations return `liveSync` (`ok`/`failed`/`skipped`) and
  best-effort `PUT /v1/sessions/{id}/glossary` with the merged list: a
  session-scoped change pushes to that session, a global change to every
  `starting`/`running` session. The pipeline endpoint lands with M4-02;
  failures are swallowed so edits always persist for the next start.
- UI: `admin/_components/glossary-editor.tsx` (list + add/edit form + bulk
  paste, shared by both scopes), `/admin/glossary` (global editor, linked
  from the dashboard header), session glossary editor plus a read-only
  "effective glossary" preview on `/admin/sessions/[id]`.
- i18n: `adminGlossary*` + `adminCancel` keys in `es` and `en`.
- Drive-by fix: `monitoring-dashboard.tsx` imported `ConnectionPill` from
  `~/app/(audience)/_components/` (stale path from M2-02); pointed at
  `~/app/_components/` so `pnpm typecheck` is clean again.

Verification:

- `DATABASE_URL_TEST=postgres://…/babbage_test_m401 pnpm test`: 132 tests
  pass, including merge order/dedupe/cap, bulk-paste parsing, per-scope
  list, upsert dedupe, `addMany` skip counts, live `PUT` on running
  sessions (all active sessions for global edits), skip when idle, and
  tolerance of a 404 from the not-yet-implemented endpoint.
- `pnpm lint`, `pnpm typecheck`: clean.
