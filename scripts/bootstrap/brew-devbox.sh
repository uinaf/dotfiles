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

# Preserve the devbox prefix's existing shared-writer modes without weakening
# the caller's default shell umask.
umask 0002
exec brew "$@"
