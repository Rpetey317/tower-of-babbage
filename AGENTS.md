# AGENTS.md

Operating guide for humans and AI agents working on Tower of Babbage. Read this
file completely before touching the repository.

## 1. Read first, in this order

1. [README.md](README.md): what the project is.
2. [docs/architecture.md](docs/architecture.md): components and data flow.
3. [docs/contract.md](docs/contract.md): the web <-> pipeline <-> browser contract. Every field name used anywhere derives from here and from [docs/domain-model.md](docs/domain-model.md).
4. The component doc for the area you will touch, under `docs/components/`.
5. [docs/roadmap.md](docs/roadmap.md): the task list. Work only on tasks listed there or on an issue that references one.
6. [docs/decisions.md](docs/decisions.md): do not relitigate a decision in code; propose a new entry instead.

## 2. Ground rules

- Everything (code, comments, docs, commit messages, UI source strings) is in English. UI copy shown to users is translated through the i18n layer (Spanish default, English toggle).
- Be concise. No documentation, explanations or features beyond what the task asks. If you notice something else worth doing, mention it in the PR description; do not do it.
- Every change ships with a reproducible way to verify it: an automated test, a command whose output proves it, or an explicit manual check listed in the PR. See section 6.
- Comments explain the purpose of functions and types, non-obvious decisions and tricky algorithms. Do not narrate obvious code.
- Design over metrics: prefer clear boundaries and meaningful abstractions over mechanical rules about function length or nesting.
- Never commit secrets. Configuration comes from environment variables documented in [docs/deployment.md](docs/deployment.md); each app keeps an `.env.example`.
- Do not run destructive git operations (force push, history rewrite, branch deletion of others' work).
- Ask before changing scope. A question at the end of a PR or issue comment is fine; silently widening or narrowing a task is not.

## 3. Repository layout and ownership

| Path | Owns | Language |
| --- | --- | --- |
| `apps/web/` | Postgres schema and all public HTTP: audience view, admin panel, overlay, export, tRPC, internal events endpoint | TypeScript (T3: Next.js App Router, tRPC v11, Drizzle, Tailwind v4, Biome) |
| `services/pipeline/` | Audio ingest, chunking, speech providers, event emission, control API. Never touches the database. | Go 1.24 |
| `packages/contract/` | JSON fixtures that both sides must parse. Source of truth is [docs/contract.md](docs/contract.md). | JSON |
| `infra/` | `compose.yml`, Dockerfiles, llama-server configuration, model download script | YAML, shell, PowerShell |
| `fixtures/audio/` | Short speech samples with license notes | WAV |
| `scripts/` | `smoke.sh`, benchmarks | shell, PowerShell |
| `docs/` | Design docs, roadmap, decisions, context logs, change summaries | Markdown |

Cross-boundary rule: the web app talks to the pipeline only through the control API, the pipeline talks to the web app only through the events endpoint, and the browser talks to the pipeline only through the ingest WebSocket. No shared database, no shared in-memory state.

## 4. Commands

All day-to-day commands go through the root `Makefile` so they are identical for every agent.

| Command | Effect |
| --- | --- |
| `make infra-up` / `make infra-down` | Start or stop Postgres and llama-server via `infra/compose.yml` |
| `make model-pull` | Download the Gemma 4 GGUF and mmproj used by llama-server |
| `make web` | `pnpm dev` in `apps/web` |
| `make pipeline` | `go run ./cmd/pipeline` in `services/pipeline` |
| `make db-push` | Apply the Drizzle schema to the local database |
| `make test` | `go test ./...` and `pnpm test` (Vitest) |
| `make lint` | Biome (web) and `go vet` + `staticcheck` (pipeline) |
| `make smoke` | End-to-end run with the mock provider and a fixture WAV, see [docs/testing.md](docs/testing.md) |

Until M0 lands these targets do not exist yet; M0 tasks create them.

For native Windows inference without `make`, use the `dev.ps1` task runner
(`.\dev.ps1 model-pull`, `.\dev.ps1 inference`, `.\dev.ps1 transcribe` and
`.\dev.ps1 test-inference` for the offline suite); see the native Windows
section of [docs/deployment.md](docs/deployment.md).

## 5. Contract changes

The contract is the one place where parallel work can break. Rules:

1. Change [docs/contract.md](docs/contract.md) first, in its own PR or as the first commit.
2. Update or add the fixture JSON in `packages/contract/fixtures/`.
3. Update the Go structs and the Zod schemas so that both test suites parse the fixtures.
4. Bump the `contractVersion` constant documented in the contract.

A PR that changes only one side of the contract is not mergeable.

## 6. Definition of done

A task is done when all of the following hold:

- Acceptance criteria from the roadmap task or issue are met.
- Verification exists and passes: unit tests for logic, fixture-based tests for anything touching the contract, `make smoke` for anything touching the end-to-end path. When no automated check is feasible, the PR lists the exact manual steps and their observed output.
- `make lint` and `make test` pass.
- Docs affected by the change are updated in the same PR (component doc, contract, deployment, roadmap status).
- A short change summary is added under `docs/changes/<date>-<topic>.md` for review. The reviewer deletes it after review.

## 7. Workflow

1. Pick a task from [docs/roadmap.md](docs/roadmap.md), respecting milestone order and dependencies. Prefer tasks marked parallelizable if others are active.
2. Open a GitHub issue with the template in `.github/ISSUE_TEMPLATE/task.md`. Title: `<task id>: <short description>`, for example `M1-03: chunker with pause snapping`. Apply labels `component:<web|pipeline|infra|contract|docs>`, `milestone:<M0..M6|backlog>`, `size:<S|M|L>`.
3. Branch from `main`: `<type>/<task-id>-<slug>`, for example `feat/m1-03-chunker`.
4. Commit with Conventional Commits: `feat(pipeline): add pause-snapping chunker`. Scopes: `web`, `pipeline`, `contract`, `infra`, `docs`.
5. Open a PR that links the issue, lists verification steps and their output, and states anything left out and why.
6. Keep PRs small. One roadmap task per PR unless tasks are trivially coupled.

## 8. Code conventions

TypeScript (`apps/web`)
- Strict TypeScript, no `any` without a comment explaining why.
- Validate every external input with Zod: tRPC inputs, the internal events endpoint, environment variables (`@t3-oss/env-nextjs`).
- Server code lives in `src/server/`, React Server Components by default, client components only where interactivity is needed.
- Styling with Tailwind using the tokens defined in [docs/branding.md](docs/branding.md). No ad-hoc hex values in components.
- All user-visible strings go through the i18n dictionaries described in [docs/components/languages.md](docs/components/languages.md).

Go (`services/pipeline`)
- Standard library first; add a dependency only when it removes real complexity (WebSocket, ONNX runtime for VAD).
- Package by concern: `ingest`, `chunk`, `provider`, `emit`, `control`. Interfaces are defined where they are consumed.
- Every goroutine has an owner and a cancellation path (`context.Context`). No naked `go func()`.
- Errors are wrapped with context and surfaced as `log` events to the web app when they affect a session.

Both
- Timestamps inside a session run are milliseconds of audio since the run started, never wall-clock. Wall-clock appears only in `emittedAt` and derived latency.
- Language identifiers are lowercase BCP 47 primary tags (`en`, `es`, `pt`).

## 9. Documentation duties

- `docs/changes/`: one file per merged task summarizing what changed, for the reviewer. Delete after review.
- `docs/context/`: relevant conversations, Q&A and clarifications that shaped decisions. Append to the file for the day or create a new one.
- `docs/decisions.md`: append an entry when a non-trivial technical choice is made. Keep the format used there.
- `docs/roadmap.md`: update task status (`todo`, `doing`, `done`) when you start and finish.

## 10. Hackathon mode

Until the Vibeathon deadline (see the roadmap header), the priority order is fixed: M1 vertical slice, M2 multi-session and monitoring, M3 export, M4 glossary, M5 overlay, M6 languages. Anything in the backlog waits. Prefer the simplest implementation that satisfies the acceptance criteria and note the intended upgrade path in the component doc instead of building it.
