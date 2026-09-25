# Video playback

Location: `apps/web/src/app/(audience)/s/[slug]/play`,
`apps/web/src/app/api/media/[slug]`, `apps/web/src/lib/playback.ts`.

Public, no login. `/s/[slug]/play` renders the video a `file_replay`
session replays with its captions overlaid on the player, synced to the
playhead. Replaying a video container already works end to end:
`file_replay` runs `ffmpeg -re -i <path>` under `FIXTURES_DIR`, which
demuxes the audio track of an mp4/webm/mov/mkv into the normal frame
stream (see [ingest.md](ingest.md)).

## Routes

| Route | Content |
| --- | --- |
| `/s/[slug]/play` | Playback view. Same query params as `/s/[slug]`: `lang`, `mode`, `hl`. |
| `GET /api/media/[slug]` | Streams the session's video fixture with `Range` support. |

A session has a playable video when `sourceType` is `file_replay` and its
`sourceConfig.path` is a safe relative path ending in a playable video
extension (`videoMediaPath` in `src/lib/playback.ts`). `/s/[slug]/play` on
any other session shows a "no video" notice instead of a player.

## Media serving

The browser cannot reach the pipeline's `FIXTURES_DIR`, so the web app
streams the file itself from `MEDIA_DIR` (default `../../fixtures/audio`,
the same tree the pipeline reads in development). The route resolves the
session by slug, re-validates the stored `sourceConfig.path` and refuses
absolute paths, backslashes and `..` segments; the resolved path must stay
inside `MEDIA_DIR`. Keying the route by slug means only files a session
actually references are servable.

Single-byte `Range` requests are answered with `206` and `Content-Range`
so `<video>` seeking works; unsatisfiable ranges get `416`.

## Sync model

Segment `startMs`/`endMs` are milliseconds of audio since run start; for a
`-re` file replay that equals media time in the file, so
`video.currentTime * 1000` selects the cue directly. Playback is seekable:
the view does not lock the playhead to the live run, pausing and seeking
only move `currentTime` and cue selection follows.

`cueAt(chunks, timeMs)` picks the latest chunk whose `startMs` is already
past and keeps it on screen until `endMs + cueLingerMs` (2 s). The linger
covers translations that are emitted after their audio window ends —
without it a translation cue would never appear for a viewer tracking
live media time. In silence gaps longer than the linger no cue is shown.

## Data

- The page fetches `segments.recent` for **all** session languages
  (limit 200) and subscribes to `segments.onSegment` with the same set, so
  the language/mode switches never wait on a refetch. Cue text is rendered
  through `chunkText` from `src/lib/captions.ts`.
- Chunks are merged with the shared `captionsReducer`, so its 64-chunk
  cap applies: videos whose runs produce more than 64 chunks lose their
  earliest cues. Fine for the demo fixture (about a dozen chunks); a
  longer-form recording needs a paged "all segments" query (backlog).

## Fixture

`fixtures/audio/en-kubernetes-60s.mp4`: 62 s of a generated test pattern
with the existing `en-kubernetes-60s.wav` audio track; generation command
and license in `fixtures/audio/LICENSES.md`. The `demo-video` seed
session (`pnpm db:seed` or the admin demo button) points at it.

## Verification

- `src/lib/playback.test.ts`: `cueAt` windows, linger and gaps; range and
  path validation.
- `src/app/api/media/[slug]/route.test.ts`: 200/206/416/404 against the
  committed fixture and the test database.
- Manual: `pnpm db:seed`, start `demo-video` with `PROVIDER=mock`, open
  `/s/demo-video/play`; captions track the playhead within ~1 s, pause and
  seek keep cue state consistent.
