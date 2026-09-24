# Web app

From the repository root, run `pnpm install`, then copy
`apps/web/.env.example` to `apps/web/.env`. The example database URL matches
the Postgres service in `infra/compose.yml`.

Start Postgres with
`docker compose --env-file infra/.env.example -f infra/compose.yml --profile infra up -d postgres`.
Then run `make web` and open `http://localhost:3000` or
`http://localhost:3000/api/health`. The health route returns `{"status":"ok"}`
only when it can query Postgres. Run `pnpm --dir apps/web lint`,
`pnpm --dir apps/web typecheck`, and `pnpm --dir apps/web test` to check the
web scaffold.

Before a production build, set a password of at least 12 characters and replace
both example secrets with distinct base64-encoded values of at least 32 bytes.
