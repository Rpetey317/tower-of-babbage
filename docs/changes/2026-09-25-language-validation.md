# 2026-09-25 — Supported language validation (M6-01)

Issue #36. Language allowlist shared by the admin form and the router.

- `lib/languages.ts` (new): `SUPPORTED_LANGUAGES` — `en`, `es`, `pt` verified;
  `fr`, `de`, `it` selectable but unverified — mirrors the pipeline's
  `provider/languages.go` table (docs/components/languages.md).
- `session-form.tsx`: source select and the ordered target multi-select now
  offer all six codes; unverified entries are labelled
  (`adminLanguageUnverified` key added to `es`/`en`). `languages` removed
  from `lib/admin/options.ts`.
- `admin.ts` router: `language` input refined to `isSupportedLanguage`, so
  create/update reject unknown codes with `BAD_REQUEST`. The contract Zod
  schema stays permissive — any BCP 47 primary tag is valid wire format;
  support is enforced by the pipeline at start.
- Pipeline side needed no changes: the Go language table and
  `unsupported_language` 400 already shipped with M1-12. Added
  `control/languages_test.go` covering the `pt -> es` acceptance (202) at
  the contract boundary.
- Tests: `languages.test.ts` (list mirrors the Go table, verified set is
  exactly `en`/`es`/`pt`, rejects `en-US`/`xx`); `admin.test.ts` cases for
  `pt -> es` create+start body, unverified codes accepted, `xx`/`en-US`
  rejected on create and update.

Verification: `go test ./...` + `go vet` + `staticcheck` clean;
`pnpm test` (199 tests, route tests against `babbage_test_m601` — dedicated
DB since the shared `babbage_test` and dev servers belong to the parallel
M1-14 run), `pnpm lint`, `pnpm typecheck`. `make smoke` intentionally not
run: web :3000 and pipeline :8090 are in use by the parallel run; the
change is covered by the route and control tests above.
