#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"$repo_root/scripts/bootstrap/apply-dotfiles.sh"
"$repo_root/scripts/bootstrap/trust-agent-worktrees.sh"
"$repo_root/scripts/bootstrap/install-gh-extensions.sh"

if command -v npm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack disable pnpm
  fi
  npm install --global --allow-scripts=pnpm pnpm@12.0.0-beta.2
else
  printf 'skipped pnpm setup; install the pinned Node runtime with mise install\n' >&2
fi

if command -v codex >/dev/null 2>&1; then
  "$repo_root/scripts/bootstrap/configure-codex.sh"
else
  printf 'skipped Codex defaults; codex is not on PATH yet\n' >&2
fi
