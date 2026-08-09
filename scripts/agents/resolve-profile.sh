#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
expected=""
normalized_expected=""
profile_file="$HOME/.config/dotfiles/profile"

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"

usage() {
  printf 'Usage: scripts/agents/resolve-profile.sh [--expected PROFILE]\n'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected)
      shift
      if [ "$#" -eq 0 ]; then
        usage >&2
        exit 2
      fi
      expected="$1"
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

if [ -n "$expected" ]; then
  if ! normalized_expected="$(dotfiles_normalize_profile "$expected")"; then
    printf 'unsupported expected profile: %s\n' "$expected" >&2
    exit 2
  fi
  expected="$normalized_expected"
fi

if ! profile="$(dotfiles_read_persisted_profile "$profile_file" "$(id -u)")"; then
  printf 'cannot use agent sync; profile marker is missing or unsafe: %s\n' "$profile_file" >&2
  printf 'repair it with: scripts/bootstrap/apply-dotfiles.sh --profile %s\n' "${expected:-PROFILE}" >&2
  exit 3
fi

if [ -n "$expected" ] && [ "$profile" != "$expected" ]; then
  printf 'cannot use agent sync; expected profile %s but %s contains %s\n' \
    "$expected" "$profile_file" "$profile" >&2
  printf 'repair it with: scripts/bootstrap/apply-dotfiles.sh --profile %s\n' "$expected" >&2
  exit 3
fi

if ! dotfiles_profile_is_developer "$profile"; then
  printf 'agent sync is not available for profile %s\n' "$profile" >&2
  exit 3
fi

printf '%s\n' "$profile"
