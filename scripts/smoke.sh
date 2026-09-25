#!/usr/bin/env bash
# Thin wrapper over scripts/smoke.mjs (Node 22, no dependencies) — see
# docs/testing.md "Smoke test" for preconditions and steps.
set -euo pipefail

cd "$(dirname "$0")/.."

# When running against the compose stack (`--profile all`), secrets and the
# public URLs live in infra/.env. Fill only unset variables; exported values
# always win.
from_env() {
  local name="$1" key="${2:-$1}" value
  [[ -n "${!name:-}" || ! -f infra/.env ]] && return 0
  value=$(grep -E "^${key}=" infra/.env | tail -1 | cut -d= -f2-)
  value="${value%\"}"; value="${value#\"}"
  [[ -n "$value" ]] && export "$name=$value" || true
}

from_env ADMIN_PASSWORD
from_env SHARED_SECRET
from_env WEB_URL PUBLIC_WEB_URL
from_env PIPELINE_WS_URL PUBLIC_PIPELINE_WS_URL
if [[ -z "${PIPELINE_URL:-}" && -n "${PIPELINE_WS_URL:-}" ]]; then
  export PIPELINE_URL="${PIPELINE_WS_URL/wss:/https:}"
  PIPELINE_URL="${PIPELINE_URL/ws:/http:}"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "smoke: node (>= 20) not found in PATH" >&2
  exit 2
fi

exec node scripts/smoke.mjs "$@"
