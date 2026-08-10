#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
profile=""

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

mode_of() {
  local path="$1"

  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
  else
    stat -c '%a' "$path"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      [ "$#" -gt 0 ] || fail "--profile requires assistant or service"
      profile="$1"
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

if ! profile="$(dotfiles_resolve_profile "$profile")"; then
  fail "a persisted assistant or service profile is required"
fi
dotfiles_profile_is_workload "$profile" \
  || fail "workload Git verification does not support profile: $profile"

tracked_config="$HOME/.gitconfig"
workload_config="$HOME/.gitconfig.local"
tilde='~'
expected_includes="$tilde/.gitconfig.local"
if dotfiles_profile_has_capability "$profile" githubAppAuth; then
  expected_includes="$(printf '%s\n' \
    "$expected_includes" \
    "$tilde/.config/dotfiles/github-app.gitconfig")"
fi
key=""

[ -f "$tracked_config" ] \
  || fail "missing $profile Git base config; reapply the $profile profile"
[ -f "$workload_config" ] \
  || fail "missing workload Git identity; run configure-git.sh --profile $profile"
[ "$(mode_of "$workload_config")" = "600" ] \
  || fail "$profile workload Git config must have mode 600"

tracked_entries="$(git config --file "$tracked_config" --no-includes --list)" \
  || fail "$profile Git base config cannot be parsed"
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  key="${entry%%=*}"
  case "$key" in
    core.ignorecase|include.path) ;;
    *) fail "$profile Git base config contains unsupported key: $key" ;;
  esac
done <<< "$tracked_entries"
include_paths="$(git config --file "$tracked_config" --no-includes --get-all include.path)" \
  || fail "$profile Git base config does not include ~/.gitconfig.local"
[ "$include_paths" = "$expected_includes" ] \
  || fail "$profile Git base config has unsupported includes"

workload_entries="$(git config --file "$workload_config" --no-includes --list)" \
  || fail "$profile workload Git config cannot be parsed"
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  key="${entry%%=*}"
  case "$key" in
    user.name|user.email|commit.gpgsign|tag.gpgsign|dotfiles.identity) ;;
    *) fail "$profile workload Git config contains unsupported key: $key" ;;
  esac
done <<< "$workload_entries"

[ -n "$(git config --file "$workload_config" --get user.name)" ] \
  || fail "$profile workload Git user.name is empty"
[ -n "$(git config --file "$workload_config" --get user.email)" ] \
  || fail "$profile workload Git user.email is empty"
[ "$(git config --file "$workload_config" --get commit.gpgsign)" = false ] \
  || fail "$profile workload commits must not use a persisted signing key"
[ "$(git config --file "$workload_config" --get tag.gpgsign)" = false ] \
  || fail "$profile workload tags must not use a persisted signing key"
[ "$(git config --file "$workload_config" --get dotfiles.identity)" = workload ] \
  || fail "$profile Git identity is not marked as workload-owned"

printf 'ok %s Git base and workload identity match the expected profile contract\n' "$profile"
