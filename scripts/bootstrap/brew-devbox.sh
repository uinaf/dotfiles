#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/lib/homebrew.sh
. "$repo_root/scripts/lib/homebrew.sh"

if ! command -v brew >/dev/null 2>&1; then
  printf 'brew is required before running this script\n' >&2
  exit 1
fi

dotfiles_homebrew_require_prefix_owner

if [ "${1:-}" = "--repair-shared-readability" ]; then
  if [ "$#" -ne 1 ]; then
    printf 'Usage: %s --repair-shared-readability\n' "$0" >&2
    exit 2
  fi
  dotfiles_homebrew_repair_shared_readability
  dotfiles_homebrew_verify_prefix_permissions
  exit 0
fi

# Keep the prefix writable only by its owner while preserving group read and
# traverse access for the other identities that consume its installed tools.
dotfiles_homebrew_verify_prefix_permissions
umask 0027
set +e
brew "$@"
brew_status=$?
set -e

repair_status=0
dotfiles_homebrew_repair_shared_readability || repair_status=$?
if [ "$repair_status" -eq 0 ]; then
  dotfiles_homebrew_verify_prefix_permissions || repair_status=$?
fi

if [ "$brew_status" -ne 0 ]; then
  exit "$brew_status"
fi
exit "$repair_status"
