#!/usr/bin/env bash
set -euo pipefail

mode="trust"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/trust-agent-worktrees.sh [--check]

Trusts existing mise config files near the roots of Codex and Claude generated
worktrees. With --check, verifies that any discovered config files are already
trusted.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      mode="check"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if ! command -v mise >/dev/null 2>&1; then
  printf 'missing required command: mise\n' >&2
  exit 1
fi

worktree_roots=(
  "${CODEX_HOME:-$HOME/.codex}/worktrees"
  "${CLAUDE_HOME:-$HOME/.claude}/worktrees"
)

section() {
  printf '\n## %s\n' "$1"
}

trust_status() {
  local config_path="$1"
  local config_dir
  local display_dir
  local output

  config_dir="$(dirname "$config_path")"
  config_dir="$(cd "$config_dir" && pwd -P)"
  display_dir="${config_dir/#$HOME/~}"
  output="$(mise trust --show -C "$config_dir" 2>&1)"
  awk -F': ' -v config_dir="$config_dir" -v display_dir="$display_dir" '
    ($1 == config_dir || $1 == display_dir) && $2 == "trusted" { found = 1 }
    END { exit !found }
  ' <<< "$output"
}

find_mise_configs() {
  local root

  for root in "${worktree_roots[@]}"; do
    [ -d "$root" ] || continue
    find "$root" -maxdepth 3 -type f \( -name 'mise.toml' -o -name '.mise.toml' \) -print
  done | sort
}

main() {
  local config_path
  local found=0
  local failed=0

  if [ "$mode" = "check" ]; then
    section "agent worktree mise trust"
  fi

  while IFS= read -r config_path; do
    [ -n "$config_path" ] || continue
    found=1

    if [ "$mode" = "check" ]; then
      if trust_status "$config_path"; then
        printf 'ok trusted %s\n' "$config_path"
      else
        printf 'FAILED: untrusted mise config: %s\n' "$config_path" >&2
        failed=1
      fi
    else
      mise trust --yes "$config_path"
    fi
  done < <(find_mise_configs)

  if [ "$found" -eq 0 ]; then
    if [ "$mode" = "check" ]; then
      printf 'ok no agent worktree mise configs found\n'
    else
      printf 'no agent worktree mise configs found\n'
    fi
  fi

  if [ "$failed" -ne 0 ]; then
    printf 'Run %s/scripts/bootstrap/trust-agent-worktrees.sh\n' "$repo_root" >&2
    exit 1
  fi
}

main "$@"
