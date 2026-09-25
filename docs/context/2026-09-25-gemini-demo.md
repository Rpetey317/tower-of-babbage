# 2026-09-25: Demo and MVP switch to Gemini

Clarification from the project owner, recorded per the project rule of
documenting decisions and clarifications.

## What changed

- For the demo and the MVP, inference runs over a cloud model: the Gemini API.
- The local-first direction (Gemma 4 on llama.cpp/vLLM, ADR-002) is no longer
  the demo path; it stays as the self-hosted option. Recorded as ADR-011.
- The brief's recommendation ("build it on Gemini's audio capabilities; if you
  want it 100% local, use Gemma") now maps to: Gemini for the demo/MVP, Gemma
  for the self-hosted deployment.

## Effect on the plan

- New roadmap task M1-16 implements the `gemini` provider (`generateContent`
  with `inlineData` WAV, `GEMINI_API_KEY`/`GEMINI_MODEL`).
- M0-08 (Gemma 4 check on the demo box) and M1-10 (`openaicompat` provider)
  remain valid work but leave the critical path.
- M1-14 (first real run) now exercises the Gemini path instead of a LAN
  llama-server; the demo needs no GPU, only an API key and outbound internet.
- The Gemini Live API (streaming transcription, bypassing the chunker) is the
  relevant backlog item replacing the old "gemini provider" entry.
