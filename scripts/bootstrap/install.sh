#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"$repo_root/scripts/bootstrap/apply-dotfiles.sh"

if command -v codex >/dev/null 2>&1; then
  "$repo_root/scripts/bootstrap/configure-codex.sh"
else
  printf 'skipped Codex defaults; codex is not on PATH yet\n' >&2
fi
