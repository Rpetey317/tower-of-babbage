# Video playback with synced captions (M7-01)

Added a playback view at `/s/[slug]/play`: it plays the video a
`file_replay` session replays and overlays the session's captions on the
player, synced via `video.currentTime` against segment `startMs`/`endMs`.

- `GET /api/media/[slug]` streams the session's `sourceConfig.path` from
  `MEDIA_DIR` (new env var, default `../../fixtures/audio`) with `Range`
  support; only files referenced by a session are reachable.
- `src/lib/playback.ts`: `videoMediaPath` (safe-path + video extension
  gate), `parseRange`, `cueAt` (latest chunk with `startMs <= t`, held
  until `endMs + 2 s` so late translations still render).
- `sessions.bySlug` now returns `sourceType`/`sourceConfig`.
- New fixture `fixtures/audio/en-kubernetes-60s.mp4` (generated test
  pattern + the existing licensed audio track) and a `demo-video` seed
  session; licenses in `fixtures/audio/LICENSES.md`.
- New i18n keys (`playbackCaptionLink`, `playbackNoVideo`,
  `playbackVideoLabel`) in `es`/`en`.
- Docs: new [components/playback.md](../components/playback.md), notes in
  ingest/deployment/stack, ADR-014, roadmap M7 entry.

Verify: `pnpm test`, `pnpm lint`, `pnpm typecheck` green; manual —
`pnpm db:seed`, start `demo-video` under `PROVIDER=mock`, open
`/s/demo-video/play`, captions track the playhead within ~1 s and
pause/seek keeps cue state consistent.
