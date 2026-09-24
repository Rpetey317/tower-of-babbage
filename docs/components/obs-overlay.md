# OBS / vMix overlay

Location: `apps/web/src/app/overlay/[slug]/page.tsx`.

The cheapest integration with every streaming tool is a web page with a
transparent background: OBS Browser Source, vMix Web Browser input, and
hardware encoders with HTML overlays all render it. No plugin, no websocket
protocol per tool.

## Route

`GET /overlay/[slug]?lang=es&lines=2&size=48&align=bottom&bg=band&font=hyperlegible`

| Param | Default | Meaning |
| --- | --- | --- |
| `lang` | first target language | Language to show; `mode=both` stacks original above translation |
| `lines` | `2` | Maximum visible lines; older text scrolls out |
| `size` | `48` | Font size in px at 1080p; scales with viewport width |
| `align` | `bottom` | `bottom` or `top` |
| `bg` | `band` | `band` (semi-opaque `ink-950` band behind text), `box` (per-line boxes), `none` |
| `margin` | `64` | Safe-area margin in px |

Body background is fully transparent (`background: transparent`), no header,
no controls, no cursor. Text uses Atkinson Hyperlegible with a 2 px outline and
drop shadow so it survives `bg=none` over busy video.

## Behaviour

- Subscribes like the audience page, keeps the last `lines` lines after
  wrapping at the current width.
- New text appears without animation by default (encoders and viewers with
  reduced motion); `anim=fade` enables a 150 ms fade.
- Reconnects silently; shows nothing (rather than an error) while
  disconnected so the stream never displays debugging text.
- Session not live: renders empty.

## OBS setup (documented for operators)

1. Sources > Add > Browser. URL: `https://<host>/overlay/gran-sala?lang=es`.
2. Width 1920, height 1080, FPS 30, custom CSS empty (the page handles it).
3. Check "Shutdown source when not visible" off, "Refresh browser when scene
   becomes active" on.
4. Place at the bottom; the page already leaves the safe margin.

vMix: Add Input > Web Browser, same URL, 1920x1080.

## Backlog

- obs-websocket client in the pipeline that pushes captions with
  `SendStreamCaption` for platforms that ingest CEA-608 from OBS.
- Per-session overlay presets stored in the database.

## Verification

- Playwright (backlog) or manual: open the URL in a browser with a checkered
  background extension; text is readable, background transparent.
- Manual with OBS: add the source during a `make smoke` run; captions appear
  and scroll with at most `lines` visible.
