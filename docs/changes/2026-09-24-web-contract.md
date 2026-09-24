# M0-05: web contract schemas and ingest tokens

Added Zod schemas for the documented control API, events API, and ingest
WebSocket messages. Fixture tests round-trip the shared JSON examples and
reject invalid contract versions and message fields. Ingest tokens use the
decoded base64 shared secret as an HMAC-SHA256 key, a 10-minute expiry, and
constant-time signature comparison; tests cover the shared vector, expiry,
tampering, and session binding.

Verification: `pnpm --dir apps/web test`, `pnpm --dir apps/web typecheck`,
`make test`, and `make lint`. No GPU is needed for these checks.
