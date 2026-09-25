# Compose profile `all` (M2-05)

Added the containerized application stack: `apps/web/Dockerfile` builds a
Next.js standalone image (`output: "standalone"`, `outputFileTracingRoot` at
the repo root, `SKIP_ENV_VALIDATION` at build time) whose entrypoint applies
the Drizzle migrations from `drizzle/` via `docker/migrate.mjs` before
starting `server.js`. `services/pipeline/Dockerfile` gained `curl` for its
healthcheck. `infra/compose.yml` now defines `web` and `pipeline` under
profile `all` with health checks on every service; the web service waits for
Postgres to be healthy and serves on `${WEB_BIND_HOST}:${WEB_PORT}` (default
`0.0.0.0:3000`), the pipeline on `PIPELINE_*` (default `8090`) with
`fixtures/audio` mounted read-only at `/fixtures`.

`llama` moved out of `all` into `infra` only: `--profile all` now works on
machines without `/dev/dri` (e.g. Docker Desktop on WSL2 exposes `/dev/dxg`,
which the Vulkan image cannot use). GPU events run
`--profile all --profile infra` (or `--profile cpu`). `PUBLIC_*` variables in
`infra/.env` map to the web build args and runtime env
(`PUBLIC_PIPELINE_WS_URL` → `NEXT_PUBLIC_PIPELINE_WS_URL`). `infra/.env.example`
ships secrets that pass the web app's production validation so a clean
machine can `up` without edits; deployments must replace them. `PROVIDER`
defaults to `mock` in the example. Host ports are overridable
(`WEB_PORT`, `PIPELINE_PORT`, `POSTGRES_PORT`, `LLAMA_PORT`) so parallel
checkouts don't collide. `scripts/smoke.sh` fills unset `ADMIN_PASSWORD`,
`SHARED_SECRET`, `WEB_URL`, `PIPELINE_URL` from `infra/.env`.

Verification on this machine (no GPU, sibling clone holding 5432/8080):
`WEB_PORT=3300 PIPELINE_PORT=8091 POSTGRES_PORT=55432 docker compose -p
tob-m205 --env-file infra/.env -f infra/compose.yml --profile all up -d
--wait` → all three services healthy; `docker logs` shows `migrate: schema up
to date` before Next.js ready; `GET /` renders the audience page,
`GET /api/health` and `GET :8091/healthz` return ok; `WEB_URL=… PIPELINE_URL=…
make smoke` → `smoke: PASS in 34.2s` (3+3 segments, 3-cue SRT export).
`make lint` and `make test` pass. The `llama` healthcheck uses `curl`, which
is present in the published images.
