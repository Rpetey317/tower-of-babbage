# Contract fixtures (M0-04)

Added the nine JSON fixtures listed in contract section 7. The examples share
session and run IDs and include original, translation, status, and log events.
The ingest token vector is generated from fixed synthetic claims and a 32-byte
secret by `node packages/contract/tools/make-token-vector.mjs`.

Verification: regenerate the vector and check that Git shows no difference;
inspect each fixture against contract sections 2–5; run `make test` and
`make lint`. Model and GPU checks do not apply to contract fixtures.
