# 2026-09-25 — Speaker-colored captions (M7-02)

Issue #79. `segment` events can carry an optional `speaker` label attributed
by the provider; the audience view renders a localized `Speaker n` label and
tints each speaker's text in a deterministic branding accent.

- Contract v2 (`docs/contract.md`, `events.batch.json`): `speaker` is an
  optional non-empty string on `segment`; `contractVersion` bumped to 2 on
  both sides (`contract/index.ts`, `internal/contract/messages.go`). Fixture
  round-trips assert the field in Go and Vitest; v1 batches now fail the
  version gate.
- Pipeline: `provider.Transcript` is now a struct `{ Text, Speaker }`; the
  ASR/AST prompts ask for an `S<n>:` tag and `splitSpeaker` (`speaker.go`)
  parses it, tolerating untagged output. The runner copies the label onto the
  chunk's original and translation events. The mock rotates `S1, S1, S2, S2,
  ...` by chunk index.
- Web: `segments.speaker` nullable column (Drizzle push); the events route
  upserts it and `segments.recent`/`onSegment` return it.
  `lib/speakers.ts` maps `S<n>` onto the accent palette (`S1` -> `cyan`,
  cycling; other labels hash into the same set) and renders the localized
  name. `caption-view` shows the label + tinted text; the overlay tints
  non-muted lines. Segments without `speaker` render exactly as before.
- Tests: provider tests cover tag parsing and the mock rotation; runner test
  asserts `speaker` on both event kinds; `speakers.test.ts` pins the
  palette mapping and stability; `captions.test.ts` covers `chunkSpeaker`;
  route test asserts persistence.
- Docs: contract, domain-model, speech-engine, audience-web, roadmap M7,
  ADR-015 (prompt tags vs. diarization).

Verification: `go test ./...` + `go vet` + `staticcheck` clean; Vitest 211
green against dedicated `babbage_test_m702`; `pnpm lint` + `tsc` clean;
`smoke.mjs` PASS on isolated ports (web :3100 on `babbage_dev_m702`, pipeline
:8091 `PROVIDER=mock`) including the new every-segment-has-a-speaker check.
Manual: server-rendered `/s/spk-demo` shows `Orador 1`/`Speaker 1` over
`text-cyan` text, `Orador 2`/`Speaker 2` over `text-violet`, and an
unattributed chunk unchanged in `text-ink-100`.
