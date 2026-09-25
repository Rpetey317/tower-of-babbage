#!/usr/bin/env bash
# Thin wrapper over scripts/smoke.mjs (Node 22, no dependencies) — see
# docs/testing.md "Smoke test" for preconditions and steps.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "smoke: node (>= 20) not found in PATH" >&2
  exit 2
fi

exec node scripts/smoke.mjs "$@"
