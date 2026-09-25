# Docs: Gemini as the demo/MVP provider

Documentation-only change accommodating the owner's decision to run the demo
and MVP over the Gemini API instead of local Gemma 4.

- README and architecture: Gemini is the default inference path; llama.cpp /
  vLLM moved to "local option" in diagrams, topologies and the latency budget.
- decisions: ADR-002 marked partially superseded; new ADR-011 records the
  switch, its rationale and consequences.
- roadmap: new M1-16 (gemini provider) on the critical path; M0-08 and M1-10
  annotated as local-path-only; M1-14 and M2-04 repointed at the Gemini demo;
  backlog now lists the Gemini Live API instead of the gemini provider.
- stack: inference section covers `generateContent`/`GEMINI_API_KEY`/
  `GEMINI_MODEL`; llama services marked local-only.
- deployment: demo topology rewritten for Gemini (Postgres + API key, no GPU);
  local topology kept as the alternative; checklist updated.
- speech-engine: `gemini` provider section added; `openai-compat` marked as
  the local path; sizing and verification updated.
- testing, languages, docs index: small consistency edits.
- New context log `docs/context/2026-09-25-gemini-demo.md`.

No code changes. `PROVIDER=gemini` is accepted by `internal/config` already;
the provider itself ships with M1-16.
