# M5-02: OBS / vMix operator setup doc

Scope: issue #35, expand `docs/components/obs-overlay.md` into operator
instructions verified with screenshots.

## What changed

- `docs/components/obs-overlay.md`: the 4-line "OBS setup" note became a full
  "Operator setup" section — prerequisites (URL shape, slug, `lang`, sanity
  check), a URL cookbook table, numbered OBS Browser Source steps, vMix Web
  Browser input steps, and a troubleshooting table. Verification section now
  explains how the render captures were produced.
- `docs/images/overlay/overlay-over-video.png` and `overlay-checkered.png`:
  real 1920x1080 captures of `/overlay/demo-en?lang=es` while a simulated
  session streamed segments over SSE, composited over a stage-gradient and a
  checkerboard.
- `docs/roadmap.md`: M5-02 `doing` -> `done`.

## Verification

- Screenshots are real renders, not mockups: `demo-en` in `babbage_dev_m502`
  driven to `running` via `POST /api/internal/events` (status heartbeat every
  4 s to stay under the 15 s watchdog window, plus `original`+`translation`
  segments), web dev server on :3300, headless Chromium screenshot, ffmpeg
  composite. The captions shown are the actual overlay output (2-line `band`
  default, `es` translation).
- Docs-only change; `pnpm lint` clean.

## Pending captures (for the reviewer / operator machine)

No OBS or vMix in this environment. The doc references these files under
`docs/images/overlay/` — drop the PNGs in to fill the slots:

- `obs-add-source.png` — Sources dock `+` menu with **Browser** highlighted.
- `obs-browser-source-props.png` — Browser source properties dialog with the
  overlay URL, 1920x1080, FPS 30 and the two checkboxes as documented.
- `obs-preview.png` — OBS preview while a session runs (e.g. during
  `make smoke`), captions over a test source.
- (Optional) `vmix-web-browser.png` — vMix Add Input > Web Browser dialog;
  section is text-only for now.
