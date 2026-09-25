# Admin panel foundation (M1-05)

Admin foundation per
[admin-panel.md](../components/admin-panel.md): cookie login, middleware
gate, `protectedProcedure`, `admin.sessions.*` CRUD, `start`/`stop` calling
the pipeline control API, `ingestToken`, and the minimal `/admin` pages.

- `apps/web/src/lib/auth/admin-cookie.ts`: `tob_admin` cookie as
  `expiry.signature` (expiry in unix seconds, base64url HMAC-SHA256 keyed by
  `AUTH_SECRET`, 12 h TTL) built on Web Crypto so the same code verifies on
  the edge runtime (middleware) and Node (`protectedProcedure`, login
  action). Constant-time signature compare.
- `apps/web/src/middleware.ts`: `/admin/*` other than `/admin/login`
  verifies the cookie and 307-redirects to `/admin/login` on failure. Reads
  `process.env.AUTH_SECRET` directly since `~/env` uses `Buffer` (Node-only)
  in its Zod refines.
- `apps/web/src/app/admin/login/`: server action checks `ADMIN_PASSWORD`
  with `timingSafeEqual`, sets the signed cookie (`HttpOnly`, `SameSite=Lax`,
  `secure` in prod) and redirects to `/admin`.
- `apps/web/src/server/api/trpc.ts`: `protectedProcedure` throws
  `UNAUTHORIZED` when the request's `tob_admin` cookie fails verification.
- `apps/web/src/server/api/routers/admin.ts` (`admin` router):
  `sessions.list`/`byId`/`create`/`update`/`delete` (delete refused with
  `CONFLICT` while starting/running/stopping; slug unique violations map to
  `CONFLICT slug_taken`), `start`/`stop`, and `ingestToken`.
  `start` merges glossary terms (session terms first, then globals, by
  `createdAt`), generates a `runId`, validates the body against
  `sessionStartRequestSchema`, marks the session `starting` and POSTs to
  `${PIPELINE_URL}/v1/sessions/{id}/start` with `Bearer SHARED_SECRET`;
  failures roll the session back to `error` with `lastError`. `stop` posts
  `sessionStopRequestSchema` to `/stop` and tolerates 404s (run already
  gone). `ingestToken` issues the base64url token the operator WebSocket
  will use.
- `apps/web/src/app/admin/page.tsx`: session table (title, slug, room,
  languages, status pill, last error) with per-row start/stop buttons that
  disable per status, room-color dots, edit links and a "New session"
  action.
- `apps/web/src/app/admin/sessions/new` and `/admin/sessions/[id]`: shared
  client form (title, auto-slug from title, room, room color, source
  language, target languages in click order, source type with conditional
  file-replay fields, translation mode); the `[id]` page adds status pill,
  start/stop actions, audience-page link, `lastError` display and delete
  with confirm. All copy via `es`/`en` dictionaries.
- `apps/web/vitest.config.ts`: `fileParallelism: false` — test files share
  `babbage_test` and raced each other's fixture inserts/deletes.

Verification: 24 new tests pass (cookie valid/expired/tampered/wrong-secret,
middleware redirects, router CRUD + auth gating, `start` body equals
`session-start.request.json` with mocked fetch, pipeline-failure rollback,
stop, delete-refused, ingestToken); 52 total. `make lint`, `pnpm
typecheck` and `pnpm build` clean. Manual loop verified against a
contract-faithful control-API stub (the real start/stop endpoints are
M1-12): create → start → `starting` → `running` (via status event) → stop →
`stopping` → `idle`, and delete refused while running — all exercised
through the actual UI.
