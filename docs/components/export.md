# Export

Location: `apps/web/src/server/export/`, route
`apps/web/src/app/api/export/[sessionId]/route.ts`.

Produces the full transcript of a run in SRT, WebVTT or plain text, one
language per file, straight from the `segments` table.

## Route

`GET /api/export/[sessionId]?format=srt|vtt|txt&lang=<code>&run=<runId>`

- Public (transcripts are meant to be shared); the admin page links to it.
- `run` defaults to `sessions.currentRunId`; `lang` defaults to the first
  target language; `format` defaults to `srt`.
- Response headers: `Content-Type` (`application/x-subrip`, `text/vtt`,
  `text/plain; charset=utf-8`) and
  `Content-Disposition: attachment; filename="<slug>-<lang>.<ext>"`.
- Empty run: 200 with an empty body for `txt`, a valid header-only file for `vtt`,
  and an empty file for `srt`.

## Cue construction

Segments in the selected language, current run, ordered by `chunkIndex`.
Each segment becomes one cue with `startMs`/`endMs`, then:

1. Cues longer than 7 s are split at sentence punctuation into proportional
   sub-cues (character-count weighted) so readers are not shown a wall of text.
2. Cues shorter than 800 ms are merged into the following cue.
3. Overlaps are impossible by construction (chunks are contiguous); gaps are
   preserved.
4. Lines are wrapped at 42 characters, at most two lines per cue, following
   common broadcast practice.

Timestamps: SRT `HH:MM:SS,mmm`, VTT `HH:MM:SS.mmm`. TXT is one paragraph per
cue without timestamps, with an optional `&timestamps=1` prefixing
`[HH:MM:SS]`.

## Verification

- Vitest with a fixture set of segments: golden SRT, VTT and TXT files under
  `apps/web/src/server/export/__fixtures__/`; splitting and merging edge cases
  (7.1 s cue, two 500 ms cues, empty run).
- Manual: download after a `make smoke` run and load the SRT in VLC or the VTT
  in a `<track>` element; cues align with the replayed audio.
