# Windows dotenv sourcing (M0-09)

Added `infra/env.ps1`, a shared dotenv loader dot-sourced by `dev.ps1`,
`infra/pull-model.ps1`, `infra/start-inference.ps1` and
`scripts/transcribe-file.ps1` before they read `$env:` variables. It parses
`infra/.env.example` then `infra/.env` (`KEY=VALUE` lines; comments, blank
lines, an optional `export ` prefix, surrounding quotes and whitespace are
handled; malformed lines are skipped).

Precedence: process environment > `infra/.env` > `infra/.env.example` >
built-in defaults. A variable already set in the process environment is never
overwritten, which also makes repeated loads within one `dev.ps1` invocation
idempotent. `infra/.env` stays git-ignored.

Verify: `powershell -NoProfile -File dev.ps1 test-inference` — the suite now
covers `.env` port override, process-env precedence, `.env` vs `.env.example`
merge, parser edge cases, missing dotenv files, and `INFERENCE_URLS` from
`.env` in transcribe.
