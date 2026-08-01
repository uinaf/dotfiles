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
expected_include="~"'/.gitconfig.local'
key=""
ssh_scan=""

cleanup() {
  if [ -n "$ssh_scan" ]; then
    rm -f "$ssh_scan"
  fi
}

trap cleanup EXIT

for config_override in \
  GIT_CONFIG_GLOBAL \
  GIT_CONFIG_SYSTEM \
  GIT_CONFIG_NOSYSTEM \
  GIT_CONFIG_COUNT \
  GIT_CONFIG_PARAMETERS \
  GIT_AUTHOR_NAME \
  GIT_AUTHOR_EMAIL \
  GIT_COMMITTER_NAME \
  GIT_COMMITTER_EMAIL; do
  if [ -n "${!config_override:-}" ]; then
    fail "assistant shell overrides Git config through $config_override"
  fi
done

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
[ "$include_paths" = "$expected_include" ] \
  || fail "assistant Git base config must include only ~/.gitconfig.local"

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

for tracked_backup in "$HOME"/.gitconfig.backup.*; do
  if [ -e "$tracked_backup" ] || [ -L "$tracked_backup" ]; then
    fail "assistant has a persisted backup of a previous Git base config: $tracked_backup"
  fi
done

extra_git_configs="$HOME/.config/git/config"
if [ "${XDG_CONFIG_HOME:-$HOME/.config}" != "$HOME/.config" ]; then
  extra_git_configs="$extra_git_configs
${XDG_CONFIG_HOME}/git/config"
fi
while IFS= read -r extra_git_config; do
  [ -n "$extra_git_config" ] || continue
  if [ -s "$extra_git_config" ]; then
    fail "assistant has additional user-home Git config: $extra_git_config"
  fi
done <<< "$extra_git_configs"

credential_stores="$HOME/.git-credentials
$HOME/.config/git/credentials"
if [ "${XDG_CONFIG_HOME:-$HOME/.config}" != "$HOME/.config" ]; then
  credential_stores="$credential_stores
${XDG_CONFIG_HOME}/git/credentials"
fi
while IFS= read -r credential_store; do
  [ -n "$credential_store" ] || continue
  if [ -s "$credential_store" ]; then
    fail "assistant has a persisted Git credential store: $credential_store"
  fi
done <<< "$credential_stores"

if [ -e "$HOME/.config/git/allowed_signers.local" ]; then
  fail "assistant has persisted Git signing identity material"
fi
if [ -e "$HOME/.local/libexec/dotfiles/git-ssh-sign-agentless" ] \
  || [ -e "$HOME/.local/libexec/uinaf/git-ssh-sign-agentless" ]; then
  fail "assistant has a persisted Git signing helper"
fi

for ssh_config in "$HOME/.ssh/config" "$HOME/.ssh/config.local" "$HOME/.ssh/github.config"; do
  if [ -s "$ssh_config" ]; then
    fail "assistant has user-home outbound SSH configuration: $ssh_config"
  fi
done
if [ -L "$HOME/.ssh" ]; then
  fail "assistant SSH directory must not be a symlink: $HOME/.ssh"
elif [ -d "$HOME/.ssh" ]; then
  ssh_scan="$(mktemp)"
  if ! find "$HOME/.ssh" -print0 > "$ssh_scan"; then
    fail "assistant SSH tree cannot be inspected completely"
  fi
  while IFS= read -r -d '' ssh_path; do
    if [ -L "$ssh_path" ]; then
      fail "assistant SSH tree contains a symlink: $ssh_path"
    elif [ -d "$ssh_path" ]; then
      [ -r "$ssh_path" ] && [ -x "$ssh_path" ] \
        || fail "assistant SSH directory cannot be inspected: $ssh_path"
    elif [ -f "$ssh_path" ]; then
      [ -r "$ssh_path" ] \
        || fail "assistant SSH file cannot be inspected: $ssh_path"
      if grep -Eq \
        '^(-----BEGIN ([A-Z0-9]+ )?PRIVATE KEY-----|---- BEGIN SSH2 (ENCRYPTED )?PRIVATE KEY ----|PuTTY-User-Key-File-[23]:)' \
        "$ssh_path"; then
        fail "assistant has a user-home SSH private key: $ssh_path"
      fi
    fi
  done < "$ssh_scan"
fi
if [ -n "${SSH_AUTH_SOCK:-}" ] && ssh-add -L >/dev/null 2>&1; then
  fail "assistant shell exposes SSH agent identities"
fi

gh_config_dirs="$HOME/.config/gh
${XDG_CONFIG_HOME:-$HOME/.config}/gh
${GH_CONFIG_DIR:-}"
while IFS= read -r gh_config_dir; do
  [ -n "$gh_config_dir" ] || continue
  if [ -s "$gh_config_dir/hosts.yml" ]; then
    fail "assistant has persisted GitHub CLI account configuration: $gh_config_dir/hosts.yml"
  fi
done <<< "$gh_config_dirs"

printf 'ok common assistant user-home locations contain workload Git identity without persisted GitHub credentials or SSH private keys\n'
