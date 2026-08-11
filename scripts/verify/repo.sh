#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node_binary="$(command -v node 2>/dev/null || true)"
if [ -z "$node_binary" ] || [ ! -x "$node_binary" ] \
  || ! "$node_binary" --version >/dev/null 2>&1; then
  printf 'FAILED: missing node; run mise install before repository verification\n' >&2
  exit 1
fi
exec "$node_binary" "$repo_root/scripts/verify/run.ts" "$@"
