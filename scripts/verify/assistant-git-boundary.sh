#!/usr/bin/env bash
set -euo pipefail

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

tracked_config="$HOME/.gitconfig"
workload_config="$HOME/.gitconfig.local"
tilde='~'
expected_includes="$(printf '%s\n' \
  "$tilde/.gitconfig.local" \
  "$tilde/.config/dotfiles/github-app.gitconfig")"
key=""

[ -f "$tracked_config" ] \
  || fail "missing assistant Git base config; reapply the assistant profile"
[ -f "$workload_config" ] \
  || fail "missing workload Git identity; run configure-git.sh --profile assistant"
[ "$(mode_of "$workload_config")" = "600" ] \
  || fail "assistant workload Git config must have mode 600"

tracked_entries="$(git config --file "$tracked_config" --no-includes --list)" \
  || fail "assistant Git base config cannot be parsed"
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  key="${entry%%=*}"
  case "$key" in
    core.ignorecase|include.path) ;;
    *) fail "assistant Git base config contains unsupported key: $key" ;;
  esac
done <<< "$tracked_entries"
include_paths="$(git config --file "$tracked_config" --no-includes --get-all include.path)" \
  || fail "assistant Git base config does not include ~/.gitconfig.local"
[ "$include_paths" = "$expected_includes" ] \
  || fail "assistant Git base config must include only the workload and optional GitHub App configs"

workload_entries="$(git config --file "$workload_config" --no-includes --list)" \
  || fail "assistant workload Git config cannot be parsed"
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  key="${entry%%=*}"
  case "$key" in
    user.name|user.email|commit.gpgsign|tag.gpgsign|dotfiles.identity) ;;
    *) fail "assistant workload Git config contains unsupported key: $key" ;;
  esac
done <<< "$workload_entries"

[ -n "$(git config --file "$workload_config" --get user.name)" ] \
  || fail "assistant workload Git user.name is empty"
[ -n "$(git config --file "$workload_config" --get user.email)" ] \
  || fail "assistant workload Git user.email is empty"
[ "$(git config --file "$workload_config" --get commit.gpgsign)" = false ] \
  || fail "assistant workload commits must not use a persisted signing key"
[ "$(git config --file "$workload_config" --get tag.gpgsign)" = false ] \
  || fail "assistant workload tags must not use a persisted signing key"
[ "$(git config --file "$workload_config" --get dotfiles.identity)" = workload ] \
  || fail "assistant Git identity is not marked as workload-owned"

printf 'ok assistant Git base and workload identity match the expected profile contract\n'
