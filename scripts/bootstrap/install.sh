#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"$repo_root/scripts/bootstrap/apply-dotfiles.sh"
"$repo_root/scripts/bootstrap/trust-agent-worktrees.sh"

if command -v corepack >/dev/null 2>&1; then
  corepack enable pnpm
  corepack install --global pnpm@11.15.0
else
  printf 'skipped Corepack setup; install the pinned Node runtime with mise install\n' >&2
fi

if command -v codex >/dev/null 2>&1; then
  "$repo_root/scripts/bootstrap/configure-codex.sh"
else
  printf 'skipped Codex defaults; codex is not on PATH yet\n' >&2
fi
