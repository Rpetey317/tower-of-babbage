# M1-13: end-to-end smoke test

- `scripts/smoke.mjs` (Node 22, no dependencies) implements testing.md steps
  1-4 and 6 against a running stack: `GET /api/health` + pipeline `/healthz`
  and `GET /v1/sessions` preflight (`provider: mock`, `contractVersion: 1`,
  `SHARED_SECRET` accepted), admin login, `file_replay` session
  `smoke-<timestamp>` (en -> es, `en-kubernetes-60s.wav`), start and poll
  `sessions.bySlug` until `running`, `segments.onSegment` SSE watch until 3
  original + 3 translation segments with increasing `chunkIndex` and
  `latencyMs < 2000`, then stop, wait for `idle`/`error` and delete. Any
  failed step exits non-zero after best-effort stop+delete cleanup.
- The admin login is a server action rendered through `useActionState`: the
  script scrapes the hidden `$ACTION_*` inputs from `/admin/login` and replays
  them plus `password` as a real multipart form post; success is the 303 to
  `/admin` carrying `tob_admin`.
- tRPC v11 over plain HTTP: queries are `GET /api/trpc/<path>?input=` with a
  superjson envelope (`{json: ...}`), mutations `POST` the same envelope, the
  subscription is `GET` with `Accept: text/event-stream` and yields
  `data: {"json": <event>}` plus `id:` tracking lines.
- `scripts/smoke.sh` is the thin wrapper `make smoke` already calls.
- Doc fix in testing.md step 4: the "open the SSE subscription for 25 s"
  wording assumed ~6 s chunks; measured fixture boundaries put the third
  segment near 30 s (chunks end at 9.9/15.7/30.1 s), so the window is a
  40 s deadline (`SMOKE_SSE_SECONDS`) with early exit once the threshold is
  met.
- Env: `WEB_URL`, `PIPELINE_URL` (default localhost :3000/:8090), required
  `ADMIN_PASSWORD`, `SHARED_SECRET`; overrides `SMOKE_SSE_SECONDS`,
  `SMOKE_MAX_LATENCY_MS`, `SMOKE_FIXTURE`.

Verification: `make smoke` green in 41.7 s against web on :3002 and the
pipeline on :8092 with `PROVIDER=mock` (local ports shifted to dodge the
parallel worktrees). Negative checks: wrong `ADMIN_PASSWORD` fails at step 1
with a clear message; missing env exits 2. Note for follow-up: the `.mock.txt`
line loading documented in speech-engine.md is not wired into
`cmd/pipeline` (`NewMock` gets nil lines) — smoke uses the canned text, which
is enough; worth fixing or dropping the doc claim in a later task.
