# Contract fixtures

These JSON examples follow [the cross-service contract](../../docs/contract.md),
section 7. Web and pipeline contract tests use the same files.

Regenerate `fixtures/ingest-token.vector.json` with:

```sh
node packages/contract/tools/make-token-vector.mjs
```

The vector's `secret` is a synthetic, base64-encoded 32-byte `SHARED_SECRET`.
Its `payload` is the base64url-encoded compact JSON from contract section 5,
with `sessionId` before `exp`. The HMAC key is the decoded secret bytes.
The fixed expiry is for reproducible signature tests; tests of token expiry
should control the clock.
