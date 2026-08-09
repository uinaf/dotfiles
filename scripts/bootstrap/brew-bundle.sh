#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
profile=""
shared_only=0
print_files=0

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"
# shellcheck source=scripts/lib/homebrew.sh
. "$repo_root/scripts/lib/homebrew.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/brew-bundle.sh workstation
  scripts/bootstrap/brew-bundle.sh devbox
  scripts/bootstrap/brew-bundle.sh assistant
  scripts/bootstrap/brew-bundle.sh service
  scripts/bootstrap/brew-bundle.sh personal
  scripts/bootstrap/brew-bundle.sh --shared-only workstation
  scripts/bootstrap/brew-bundle.sh --shared-only devbox
  scripts/bootstrap/brew-bundle.sh --shared-only assistant
  scripts/bootstrap/brew-bundle.sh --shared-only service
  scripts/bootstrap/brew-bundle.sh --print-files PROFILE

Installs the minimal base first, the developer layer for personal/workstation/devbox,
then the selected profile layers. --shared-only installs only the base.
An owner-controlled external-homebrew file can validate and skip entries
supplied by another trusted installer.
Devbox, assistant, and service host changes use the group-safe Homebrew wrapper.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    personal|workstation|devbox|assistant|service)
      if [ -n "$profile" ]; then
        usage >&2
        exit 2
      fi
      profile="$1"
      ;;
    --profile)
      shift
      if [ "$#" -eq 0 ]; then
        usage >&2
        exit 2
      fi
      case "$1" in
        personal|workstation|devbox|assistant|service)
          if [ -n "$profile" ]; then
            usage >&2
            exit 2
          fi
          profile="$1"
          ;;
        *)
          usage >&2
          exit 2
          ;;
      esac
      ;;
    --shared-only)
      if [ "$shared_only" -eq 1 ]; then
        usage >&2
        exit 2
      fi
      shared_only=1
      ;;
    --print-files)
      print_files=1
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

if [ -z "$profile" ]; then
  usage >&2
  exit 2
fi

if ! profile="$(dotfiles_normalize_profile "$profile")"; then
  usage >&2
  exit 2
fi

if [ "$print_files" -eq 1 ]; then
  if [ "$shared_only" -eq 1 ]; then
    printf '%s\n' "$repo_root/Brewfile"
  else
    while IFS= read -r file; do
      printf '%s/%s\n' "$repo_root" "$file"
    done < <(dotfiles_profile_brewfiles "$profile")
  fi
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  printf 'brew is required before running this script\n' >&2
  exit 1
fi

dotfiles_homebrew_configure_external_capabilities "$repo_root" "$profile"

run_bundle() {
  local file="$1"
  printf '\n## brew bundle --file %s\n' "$file"
  if dotfiles_profile_uses_shared_brew "$profile"; then
    "$repo_root/scripts/bootstrap/brew-devbox.sh" bundle --file "$file"
  else
    brew bundle --file "$file"
  fi
}

if [ "$shared_only" -eq 1 ]; then
  run_bundle "$repo_root/Brewfile"
else
  brewfiles=()
  while IFS= read -r file; do
    brewfiles+=("$file")
  done < <(dotfiles_profile_brewfiles "$profile")
  for file in "${brewfiles[@]}"; do
    run_bundle "$repo_root/$file"
  done
fi
