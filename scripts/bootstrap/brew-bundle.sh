#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
profile=""
shared_only=0
print_files=0
cleanup=0

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"
# shellcheck source=scripts/lib/homebrew.sh
. "$repo_root/scripts/lib/homebrew.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/brew-bundle.sh workstation
  scripts/bootstrap/brew-bundle.sh devbox
  scripts/bootstrap/brew-bundle.sh personal-workstation
  scripts/bootstrap/brew-bundle.sh personal-devbox
  scripts/bootstrap/brew-bundle.sh assistant
  scripts/bootstrap/brew-bundle.sh --shared-only workstation
  scripts/bootstrap/brew-bundle.sh --shared-only devbox
  scripts/bootstrap/brew-bundle.sh --shared-only assistant
  scripts/bootstrap/brew-bundle.sh --print-files PROFILE
  scripts/bootstrap/brew-bundle.sh --cleanup PROFILE

Installs the shared base first, the developer layer for personal-workstation/personal-devbox/workstation/devbox,
then the selected profile layers. --shared-only installs only the base.
--cleanup additionally uninstalls packages the composed profile layers no
longer declare; it cannot combine with --shared-only.
An owner-controlled external-homebrew.plist can validate and skip entries
supplied by another trusted installer.
Devbox and assistant host changes use the group-safe Homebrew wrapper.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      if [ "$#" -eq 0 ] || [ -n "$profile" ]; then
        usage >&2
        exit 2
      fi
      profile="$1"
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
    --cleanup)
      if [ "$cleanup" -eq 1 ]; then
        usage >&2
        exit 2
      fi
      cleanup=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$profile" ]; then
        usage >&2
        exit 2
      fi
      profile="$1"
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

if [ "$cleanup" -eq 1 ] && [ "$shared_only" -eq 1 ]; then
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
    HOMEBREW_BUNDLE_DOTFILES_PROFILE="$profile" \
      "$repo_root/scripts/bootstrap/brew-devbox.sh" bundle --file "$file"
  else
    HOMEBREW_BUNDLE_DOTFILES_PROFILE="$profile" brew bundle --file "$file"
  fi
}

if [ "$shared_only" -eq 1 ]; then
  brewfiles=(Brewfile)
else
  brewfiles=()
  while IFS= read -r file; do
    brewfiles+=("$file")
  done < <(dotfiles_profile_brewfiles "$profile")
fi

dotfiles_homebrew_trust_taps "$repo_root" "${brewfiles[@]}"
for file in "${brewfiles[@]}"; do
  run_bundle "$repo_root/$file"
done

if [ "$cleanup" -eq 1 ]; then
  composed="$(dotfiles_homebrew_compose_cleanup_brewfile "$repo_root" "$profile")" || exit 1
  cleanup_profile="$(dotfiles_homebrew_cleanup_profile "$profile")" || exit 1
  trap 'rm -f "$composed"' EXIT
  printf '\n## brew bundle cleanup --force (composed %s host contract)\n' "$profile"
  if dotfiles_profile_uses_shared_brew "$profile"; then
    HOMEBREW_BUNDLE_DOTFILES_PROFILE="$cleanup_profile" \
      "$repo_root/scripts/bootstrap/brew-devbox.sh" bundle cleanup --force --file "$composed"
  else
    HOMEBREW_BUNDLE_DOTFILES_PROFILE="$cleanup_profile" brew bundle cleanup --force --file "$composed"
  fi
fi
