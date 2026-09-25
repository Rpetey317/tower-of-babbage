# Database schema and demo seed (M1-01)

Implemented the application schema from [domain-model.md](../domain-model.md)
in `apps/web/src/server/db/schema.ts`: `sessions`, `segments`,
`glossary_terms`, `session_events`, the five enums (`source_type`,
`translation_mode`, `session_status`, `segment_kind`, `event_level`) and the
indexes (`segments_chunk_lang` unique, `segments_session_run_start`,
`glossary_terms_session`, `session_events_session_created`).

`pnpm db:seed` (`apps/web/src/server/db/seed.ts`, run with `tsx
--env-file=.env`) inserts the two `file_replay` demo sessions `demo-en` and
`demo-es` pointing at the audio fixtures, and is idempotent through
`onConflictDoNothing` on `slug`.

Generated the initial migration under `apps/web/drizzle/` so that
`drizzle-kit check` (now `pnpm db:check`) has migrations to validate; `push`
remains the development flow per the roadmap backlog note. Added the `out`
key to `drizzle.config.ts`, which `check` requires — without it the command
fails with a mislabeled "AWS Data API driver" error (drizzle-kit 0.30.6 bug).

Verification on a recreated `babbage` database: `pnpm db:push` applied the
schema cleanly, `pnpm db:seed` inserted both sessions and a second run
reported nothing to do, `drizzle-kit check` printed "Everything's fine".
`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
