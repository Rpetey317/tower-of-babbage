# Export route and download controls (M3-02)

`GET /api/export/[sessionId]` per `docs/components/export.md`, plus the
per-language download links on the admin session page and smoke step 5.

- `apps/web/src/app/api/export/[sessionId]/route.ts`: public route. Zod
  validates `format` (`srt|vtt|txt`, default `srt`), `lang` (default first
  target language, falling back to the source) and `run` (default
  `currentRunId`); `timestamps=1` toggles the TXT `[HH:MM:SS]` prefix.
  Segments come straight from the table ordered by `chunkIndex` and go
  through `renderExport`. Content-Disposition names the file
  `<slug>-<lang>.<ext>`; malformed params answer 400, unknown sessions 404,
  and a session that never ran answers the documented empty files.
- `route.test.ts`: headers and body for all three formats plus the
  `run`/`lang`/error paths, against `babbage_test`.
- `apps/web/src/app/admin/_components/export-links.tsx`: one row per
  language (deduped source + targets) with SRT/VTT/TXT anchors, mounted on
  `/admin/sessions/[id]` under a new `adminExportTitle` heading (es/en).
- `scripts/smoke.mjs`: step 5 stops the run, waits for `idle`/`error`, then
  downloads `?format=srt&lang=es` and requires at least 3 cues with
  well-formed, forward-moving timestamps. Step 6 keeps its own stop call as
  the failure-path cleanup (the mutation is a no-op on `idle`/`stopping`).

Verification:

- `pnpm test` against `babbage_test_m302` (dedicated DB, same convention as
  `babbage_test_m301`): all tests pass including the new route suite.
- `pnpm lint` and `pnpm typecheck` clean.
- `make smoke` green end to end on dedicated ports (web :3200, pipeline
  :8290 with `PROVIDER=mock`) against `babbage_dev_m302`, leaving the
  parallel M1-14 clone's processes on :3000/:8090 untouched; step 5 reports
  the exported cue count.
