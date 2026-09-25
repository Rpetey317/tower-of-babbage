# M5-01: OBS overlay

Scope: issue #34, `/overlay/[slug]` per `docs/components/obs-overlay.md`.

## What changed

- `src/app/overlay/[slug]/page.tsx`: `force-dynamic` server route. Resolves
  slug via `sessions.bySlug` (404 on miss), parses query params, prefetches
  `segments.recent` only when the session is `running`/`starting`.
- `src/app/overlay/_components/overlay-view.tsx`: client view reusing
  `captionsReducer`/`chunkText`/`sortedChunks` from `~/lib/captions` and the
  same `segments.recent` + `onSegment` subscription wiring as the audience
  page (retryLink/`lastEventId` catch-up handle reconnects). Renders a fixed
  `cursor-none` container; a clip window of `lines * 1.35em` with
  `overflow: hidden` enforces "at most `lines` wrapped lines". `size` and
  `margin` scale as `value * 100vw / 1920`; text is capped at `42ch`
  (branding legibility rule). `bg` = `band` (semi-opaque `ink-900` block),
  `box` (`box-decoration-clone` per line) or `none`; `align` = top/bottom;
  `anim=fade` adds a 150 ms fade. Renders nothing when the session is not
  live or the subscription is not `pending`.
- `src/lib/overlay.ts` + test: `resolveOverlayParams` — `lang`/`mode` via
  `resolveCaptionView` (so `mode=both` stacks original over translation),
  `lines` 1–8, `size` 12–192, `margin` 0–400, enum/default fallbacks for
  invalid values.
- `src/middleware.ts`: sets `x-tob-pathname` on the request (alongside
  `x-tob-locale`) so the root layout can strip chrome.
- `src/app/layout.tsx`: on `/overlay/*` renders `<body>` with
  `bg-transparent` and no site header; every other route is unchanged.
- `src/styles/globals.css`: `overlay-outline` utility (8-direction 2 px
  `text-shadow` outline in `ink-950` + drop shadow — engine-independent
  instead of `text-stroke`/`paint-order`) and `overlay-fade` keyframes.
- `vitest.config.ts`: `esbuild.jsx: "automatic"` so component SSR tests
  compile (tsconfig keeps `jsx: preserve` for Next).
- `docs/components/obs-overlay.md`: `band` corrected to `ink-900` (the token
  branding.md designates for the overlay band); `font` param marked reserved;
  viewport scaling documented.

## Unrelated fix on main

- `monitoring-dashboard.tsx` imported `connection-pill` from
  `(audience)/_components`; the file lives at `app/_components`. `main` failed
  `pnpm typecheck` because of it; the import is corrected here so checks pass.

## Interpretation notes

- "Shows nothing while disconnected" is implemented literally: the view only
  paints while `status` is `running`/`starting` AND the subscription is
  `pending`, so a dropped stream clears captions instead of freezing them.
- SSR emits an empty page (subscriptions connect client-side); first paint in
  OBS is transparent until the SSE opens.

## Verification

- `DATABASE_URL_TEST=postgres://…/babbage_test_m501 pnpm test`: 134 tests,
  13 files, all pass — 11 param-resolver cases, 8 `renderToStaticMarkup`
  cases (line cap, band/box/none, align, vw scaling, fade, empty when
  `idle`/`error`/disconnected), middleware pathname test.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean; `/overlay/[slug]`
  builds as a dynamic route.
- Manual (dev server `:3100`, dedicated `babbage_dev_m501`, contract batches
  POSTed to `/api/internal/events`): `/overlay/demo-en` returns
  `<body … bg-transparent>` with no `<header>` and empty content while idle;
  a `running` status + segments batch streams over the SSE endpoint with
  tracked ids; `/overlay/nope` is 404; `/` and `/s/demo-en` unaffected.

## Deferred

- OBS Browser Source / checkered-background visual check: no display or OBS
  in this environment (headless Firefox fails on WSL). Steps for the
  reviewer are in the PR body.
