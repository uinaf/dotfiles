#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
profile=""
print_steps=0

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/install.sh --profile workstation|devbox|assistant
  scripts/bootstrap/install.sh --profile personal   # compatibility alias
  scripts/bootstrap/install.sh --print-steps --profile PROFILE

Applies per-user dotfiles and runs only the setup steps owned by the selected
role. An existing ~/.config/uinaf/profile is used when --profile is omitted.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      if [ "$#" -eq 0 ]; then
        usage >&2
        exit 2
      fi
      profile="$1"
      ;;
    --print-steps)
      print_steps=1
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

if ! profile="$(uinaf_resolve_profile "$profile")"; then
  printf 'a supported profile is required: workstation, devbox, or assistant\n' >&2
  exit 2
fi

if [ "$print_steps" -eq 1 ]; then
  printf 'apply-dotfiles\n'
  if uinaf_profile_is_developer "$profile"; then
    printf 'trust-agent-worktrees\n'
    printf 'install-gh-extensions\n'
    printf 'install-native-pnpm\n'
    printf 'configure-codex\n'
  fi
  exit 0
fi

"$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile "$profile"

if uinaf_profile_is_developer "$profile"; then
  "$repo_root/scripts/bootstrap/trust-agent-worktrees.sh"
  "$repo_root/scripts/bootstrap/install-gh-extensions.sh"

  if command -v npm >/dev/null 2>&1; then
    if command -v corepack >/dev/null 2>&1; then
      corepack disable pnpm || true
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
fi
