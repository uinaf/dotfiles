#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf 'FAILED: missing node; run mise install before repository verification\n' >&2
  exit 1
fi
exec node "$repo_root/scripts/verify/run.ts" "$@"
