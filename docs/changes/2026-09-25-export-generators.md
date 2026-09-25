# Export generators (M3-01)

SRT, VTT and TXT transcript generation per `docs/components/export.md`, as
pure functions over an ordered segment list. The HTTP route and download
buttons are M3-02.

- `apps/web/src/server/export/cues.ts`: `buildCues` maps segments to cues
  (dropping empty text), splits cues over 7 s at sentence punctuation into
  character-proportional sub-cues, merges cues under 800 ms into the
  following cue (trailing one into the previous), and `wrapCueText` wraps at
  42 chars to at most two lines. Timestamp formatters for `HH:MM:SS,mmm`,
  `HH:MM:SS.mmm` and `[HH:MM:SS]`.
- `srt.ts` / `vtt.ts` / `txt.ts`: serializers. SRT numbers cues; VTT emits a
  `WEBVTT` header (header-only on empty runs) and sanitizes `-->` in text;
  TXT writes one paragraph per cue with an optional `[HH:MM:SS]` prefix.
- `index.ts`: `renderExport(format, segments, options)` dispatcher for the
  upcoming route.
- `export.test.ts` + `__fixtures__/`: golden files (`basic`, `split`,
  `merge`, `empty`, plus a TXT `timestamps` variant) regenerated with
  `UPDATE_GOLDEN=1`, plus unit tests for the split/merge/wrap edge cases.

Verification:

- `pnpm vitest run src/server/export`: 28 tests pass.
- `pnpm test` against `babbage_test_m301` (dedicated DB, same convention as
  `babbage_test_m202`): 142 tests pass.
- `pnpm lint` clean. `pnpm typecheck` has one pre-existing error on main in
  `src/app/admin/_components/monitoring-dashboard.tsx` (wrong
  `connection-pill` import path); unrelated to this change.
