# M1-04: audience pages

Scope: issue #12, audience view per `docs/components/audience-web.md`.

## What changed

- `src/app/(audience)/page.tsx` (new route group; replaces `src/app/page.tsx`):
  session list grouped by room with room-color dots, `SRC → TGT` language
  summary, `EN VIVO`/`Sin señal` pill; `running`/`starting` sort first, the
  rest greyed. `force-dynamic` so status is fresh per request.
- `src/app/(audience)/s/[slug]/page.tsx`: resolves `?lang` (validated against
  `[source, ...targets]`, default first target) and `?mode`
  (`translation`/`original`/`both`), loads session + `segments.recent` server
  side and renders the client caption view. Unknown slug -> 404.
- `src/app/(audience)/_components/`: `caption-view.tsx` (header controls,
  chunk list, auto-scroll, font size, subscription), `connection-pill.tsx`
  (live/reconnecting/not-live, `role="status"`), `room-dot.tsx` (roomColor ->
  Tailwind class map).
- `src/lib/captions.ts`: pure chunk-merging reducer (`Map<chunkIndex,
  {original, translations}>`), `resolveCaptionView`, `chunkText`, 64-chunk
  eviction, run-change detection with `restarted` flag. Usable later by the
  OBS overlay.
- `src/lib/captions.test.ts`: 21 Vitest cases — merge by chunkIndex,
  out-of-order placement, late-translation fill-in, duplicate upsert, restart
  via segment and via status, stale-run merge rejection, eviction,
  `resolveCaptionView`/`chunkText` behaviour.
- `src/trpc/react.tsx`: `retryLink` scoped to subscriptions so dropped SSE
  streams reconnect with backoff and resume at the last `tracked` id.
- `src/server/api/routers/segments.ts`: `{ type: "ping" }` literal typed
  `as const` so subscription consumers can discriminate on `type`.
- `src/lib/i18n/{es,en}.ts`: audience keys prepended at the top of each
  dictionary (keeps the diff away from the admin keys landing on M1-05's
  branch).

## Behaviour notes

- `?lang=<source>` renders the `original` track (`?lang=en` on demo-en shows
  originals only, per the doc's manual check).
- `both` mode shows the original in `ink-300` with the selected translation in
  `ink-100` underneath; a chunk renders as soon as the requested track exists.
- Subscription input `languages` covers the active mode only; changing
  language or mode resubscribes and refetches `segments.recent` to backfill.
- "Session restarted" shows while the view is empty after a `runId` change;
  the old run's captions stay visible on stop (`status: idle` keeps chunks).
- Font size persists in `localStorage` (`tob_caption_px`), 16–48 px stepping
  2 px from the 22/28 px defaults; scroll behaviour respects
  `prefers-reduced-motion`; `aria-live="polite"` on the newest chunk only;
  `lang` attribute per caption block; print renders black on white.

## Verification

- `DATABASE_URL_TEST=postgres://…/babbage_test_m104 pnpm test`: 60 tests
  pass (dedicated test DB so parallel agents' runs on `babbage_test` are
  untouched).
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean; `/` and `/s/[slug]`
  render as dynamic routes.
- Manual (dev server `:3100`, seeded `babbage` DB): `/` groups Sala A/Sala B
  with live + not-live pills; `/s/demo-en` renders SSR captions; `?hl=en`,
  `?lang=en` (originals only), `?mode=both`; contract batches POSTed to
  `/api/internal/events` appeared live over the SSE subscription
  (`id: <runId>:<chunk>:<lang>`), and the watchdog's `status_timeout` event
  flipped the pill to not-live over SSE.

## Deferred (needs merged stack)

- Lighthouse a11y score on `/s/demo-en`: no Chrome in this environment; built
  to the doc's checklist — run on a machine with Chrome.
- Phone + desktop check against `make smoke`: the session runner (M1-11) and
  control API (M1-12) are still open; verified here with curl-posted contract
  batches instead.
