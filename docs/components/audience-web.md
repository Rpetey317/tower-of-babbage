# Audience view

Location: `apps/web/src/app/(audience)/`.

Public, no login, mobile first. Two screens: pick a session, read captions.

## Routes

| Route | Content |
| --- | --- |
| `/` | Session list grouped by room, with the room color dot, title, source language and live indicator. Sessions in `running` first, then `idle`/`error` greyed with a "not live" label. |
| `/s/[slug]` | Caption view. Query params: `lang` (target or source language code, default: first `targetLanguages` entry), `mode` (`translation`, `original`, `both`; default `translation`), `hl` (UI locale). |

The slug is the only thing venue signage needs to show
(`https://<host>/s/gran-sala`). A QR code per session is in the backlog.

## Caption view

- Header: session title, room dot, language switch (source language plus
  every target), mode switch, font size control (A- / A+), UI locale toggle
  (`ES`/`EN`).
- Body: the last 8 chunks by default; the newest at the bottom, auto-scrolled
  while the user is at the bottom, with a "jump to live" button when they have
  scrolled up.
- `both` mode renders each chunk as original in muted text and translation in
  full contrast underneath.
- Attributed chunks show a localized `Speaker n` label over the text, and the
  text is tinted with the speaker's accent. The label (`S1`, `S2`, ...) maps
  deterministically to the accent tokens in [branding.md](../branding.md)
  (`S1` -> `cyan`, `S2` -> `violet`, cycling). These tags are best-effort and
  only stable within a chunk, so they do not reliably identify the same person
  across the session. Chunks without a `speaker` field render as before.
- Segments arriving out of order are placed by `chunkIndex`; late translations
  fill in beside their original.
- Connection state pill: live, reconnecting, session not live. On `runId`
  change the view clears and shows "session restarted".
- Text is selectable and the page prints cleanly; no ads, no cookies beyond the
  locale preference.

## Typography and contrast

Captions use Atkinson Hyperlegible at 22 px base on mobile and 28 px on
desktop, adjustable from 16 to 48 px with the font control (persisted in
`localStorage`). Body contrast is at least 7:1 on the `ink-950` background;
muted originals stay at 4.5:1. See [branding.md](../branding.md).

## Data

- Server Component renders the session and the initial `segments.recent`
  result so the page shows content before the SSE connection is up.
- Client component subscribes with `segments.onSegment({ sessionId, languages })`
  where `languages` covers the active mode (one or two codes), and merges into
  the chunk map described in [realtime.md](realtime.md).

## Accessibility

- Live region (`aria-live="polite"`) on the newest chunk only, so screen
  readers are not flooded.
- All controls keyboard reachable with visible focus rings in `cyan`.
- Respects `prefers-reduced-motion`: no scroll animation.
- Language of each caption block set with `lang` attributes so screen readers
  switch voices.

## Backlog

- QR code and short link per session on the admin panel.
- Optional light theme for bright venues.
- Word-level highlighting when partial segments exist.

## Verification

- Vitest for the chunk-merging reducer (order, late translation, run change).
- Manual: with `make smoke` running, open `/s/demo-en?mode=both` on a phone and
  a laptop; captions appear on both within 2 s of the pipeline emitting them,
  font control persists after reload, `?lang=en` shows originals only.
