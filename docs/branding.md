# Branding

## Name

Tower of Babbage: the Tower of Babel, where languages split, rebuilt by a
machine named after Charles Babbage. Written in full in prose, `tob` as the
short prefix for cookies and internal identifiers. No abbreviation in the UI.

## Palette

Inspired by the Nerdearla schedule page: near-black background, light text,
and the small colored dots that identify tracks and rooms. We deliberately do
not adopt Nerdearla's red/yellow/blue core; the brand leans on the wider dot
set with violet as primary and cyan as secondary.

Neutrals (`ink`):

| Token | Hex | Use |
| --- | --- | --- |
| `ink-950` | `#0A0A0B` | Page background |
| `ink-900` | `#131316` | Cards, overlay band |
| `ink-800` | `#1C1C21` | Header, elevated surfaces |
| `ink-700` | `#2A2A31` | Borders, dividers |
| `ink-500` | `#7C7C88` | Muted text, placeholders |
| `ink-300` | `#B8B8C2` | Secondary text, original-language captions in `both` mode |
| `ink-100` | `#F2F2F5` | Primary text, captions |

Accents:

| Token | Hex | Role |
| --- | --- | --- |
| `violet` | `#7C5CFF` (hover `#9B82FF`, pressed `#5F3FE0`) | Primary: buttons, active tabs, links, live session accent |
| `cyan` | `#2AC7E3` (hover `#57D6EC`) | Secondary: focus rings, informational states, selected language |
| `green` | `#3DD68C` | Success, live indicator |
| `orange` | `#FF8B3D` | Warnings, `starting`/`stopping` states |
| `yellow` | `#FFD23F` | Accent only (room/track color), never for actions |
| `magenta` | `#E86BFF` | Accent only |
| `grey` | `#9A9AA5` | Accent for rooms without a color |
| `coral` | `#FF5C6C` | Errors. Kept distinct from Nerdearla's brand red |

`roomColor` accepts `violet`, `cyan`, `green`, `orange`, `yellow`, `magenta`,
`grey`. Each room gets a dot and a 3 px header bar in its color on the session
list and caption view, echoing the schedule columns of the source design.

Contrast: `ink-100` on `ink-950` is above 17:1; `ink-300` on `ink-950` is
above 9:1; all accents on `ink-950` are above 4.5:1 for text at 18 px and
larger. Accent text on accent backgrounds is not used; buttons put `ink-950`
text on `violet`/`cyan` fills.

Tailwind v4 theme (`apps/web/src/styles/globals.css`):

```css
@theme {
  --color-ink-950: #0a0a0b; --color-ink-900: #131316; --color-ink-800: #1c1c21;
  --color-ink-700: #2a2a31; --color-ink-500: #7c7c88; --color-ink-300: #b8b8c2;
  --color-ink-100: #f2f2f5;
  --color-violet: #7c5cff; --color-violet-hover: #9b82ff; --color-violet-pressed: #5f3fe0;
  --color-cyan: #2ac7e3;   --color-cyan-hover: #57d6ec;
  --color-green: #3dd68c;  --color-orange: #ff8b3d; --color-yellow: #ffd23f;
  --color-magenta: #e86bff; --color-grey: #9a9aa5; --color-coral: #ff5c6c;
  --font-display: "Barlow Condensed", sans-serif;
  --font-sans: "Inter", sans-serif;
  --font-caption: "Atkinson Hyperlegible", "Inter", sans-serif;
}
```

Components use these tokens only; no raw hex in TSX.

## Typography

| Role | Font | Notes |
| --- | --- | --- |
| Display | Barlow Condensed 700, uppercase, letter-spacing 0.02em | Page titles, session titles in lists. Nods to the condensed uppercase headings of the source design |
| UI | Inter 400/500/600 | Everything else in admin and audience chrome |
| Captions | Atkinson Hyperlegible 400/700 | Designed for low-vision readers; the product is an accessibility tool, the caption font should be too |

Loaded with `next/font/google`, self-hosted at build time so venues without
internet still get the fonts.

Caption legibility rules: minimum 22 px on mobile, 28 px on desktop, line
height 1.35, maximum 42 characters per line in the overlay, no italics, no all
caps, sentence punctuation kept. Translation in `ink-100`, original in
`ink-300` when both are shown.

## Logo

Mark: five horizontal bars stacked into a tower that narrows upward, colored
bottom to top `violet`, `cyan`, `green`, `orange`, `yellow`, rounded ends, on
`ink-950`. It reads as both a tower and a stack of caption lines. Favicon uses
the bottom three bars. Wordmark: "TOWER OF BABBAGE" in Barlow Condensed, two
lines, `ink-100`, mark to the left. SVG lives in `apps/web/public/brand/`.

## Voice

Short, direct, no exclamation marks, no emojis. Spanish copy uses "vos"
forms consistent with the host event's audience (Argentina); English copy is
neutral. Status words are shared across locales where possible (`LIVE`).
