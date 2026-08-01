#!/usr/bin/env bash
set -euo pipefail

mode="configure"
app_name=""
app_id=""
installation_id=""
repos=()
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/configure-assistant-github-app.sh \
    --name NAME --app-id ID --installation-id ID --repo PATH [--repo PATH ...]
  scripts/bootstrap/configure-assistant-github-app.sh --check \
    --name NAME --app-id ID --installation-id ID --repo PATH [--repo PATH ...]

Configures one assistant Unix user to use a GitHub App for exact HTTPS
repositories. Each --repo accepts an existing checkout path or an exact
github.com/OWNER/REPO pattern, which is useful before the first private clone.
The private key must already exist at:

  ~/.config/gh/extensions/gh-app-auth/keys/NAME.pem

The command writes an owner-only Git include, configures gh-app-auth with the
exact repository patterns, and verifies Git and API access. It never prints the
private key or a generated token.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

uid_of() {
  if stat -f '%u' "$1" >/dev/null 2>&1; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

validate_owner_only_file() {
  local label="$1"
  local path="$2"
  local file_mode

  [ -f "$path" ] && [ ! -L "$path" ] || fail "$label must be a regular file: $path"
  [ "$(uid_of "$path")" = "$(id -u)" ] || fail "$label is not owned by the current user: $path"
  file_mode="$(mode_of "$path")"
  [ $((8#$file_mode & 0077)) -eq 0 ] \
    || fail "$label permissions must be owner-only: $path (mode $file_mode)"
}

github_pattern() {
  local checkout="$1"
  local origin
  local path
  local owner
  local repo

  [ -d "$checkout" ] || fail "repository checkout does not exist: $checkout"
  git -C "$checkout" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || fail "repository path is not a Git checkout: $checkout"
  origin="$(git -C "$checkout" remote get-url origin 2>/dev/null)" \
    || fail "repository has no origin remote: $checkout"
  case "$origin" in
    https://github.com/*) path="${origin#https://github.com/}" ;;
    *) fail "assistant GitHub App repositories must use an HTTPS github.com origin: $checkout" ;;
  esac
  path="${path%.git}"
  owner="${path%%/*}"
  repo="${path#*/}"
  [ -n "$owner" ] && [ -n "$repo" ] && [ "$repo" != "$path" ] \
    || fail "origin must identify github.com/OWNER/REPO: $checkout"
  case "$repo" in
    */*) fail "origin must identify exactly one GitHub repository: $checkout" ;;
  esac
  printf 'github.com/%s/%s\n' "$owner" "$repo"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      mode="check"
      shift
      ;;
    --name)
      app_name="${2:-}"
      shift 2
      ;;
    --app-id)
      app_id="${2:-}"
      shift 2
      ;;
    --installation-id)
      installation_id="${2:-}"
      shift 2
      ;;
    --repo)
      repos+=("${2:-}")
      shift 2
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
done

case "$app_name" in
  ''|*[!A-Za-z0-9._-]*) fail "--name must use only letters, numbers, dot, underscore, or hyphen" ;;
esac
case "$app_id" in ''|*[!0-9]*) fail "--app-id must be numeric" ;; esac
case "$installation_id" in ''|*[!0-9]*) fail "--installation-id must be numeric" ;; esac
[ "${#repos[@]}" -gt 0 ] || fail "at least one --repo is required"

profile="$(dotfiles_resolve_profile)" || fail "a persisted dotfiles profile is required"
[ "$profile" = assistant ] || fail "GitHub App global authentication is supported only for the assistant profile"

need_command git
need_command gh
app_auth_binary="$HOME/.local/share/gh/extensions/gh-app-auth/gh-app-auth"
[ -x "$app_auth_binary" ] || fail "missing gh-app-auth; rerun the assistant profile installer"

key_dir="$HOME/.config/gh/extensions/gh-app-auth/keys"
key_file="$key_dir/$app_name.pem"
[ -d "$key_dir" ] && [ ! -L "$key_dir" ] || fail "missing owner-only GitHub App key directory: $key_dir"
[ "$(uid_of "$key_dir")" = "$(id -u)" ] || fail "GitHub App key directory is not owned by the current user: $key_dir"
[ "$(mode_of "$key_dir")" = 700 ] || fail "GitHub App key directory must have mode 0700: $key_dir"
validate_owner_only_file "GitHub App private key" "$key_file"

patterns=()
resolved_repos=()
for checkout in "${repos[@]}"; do
  case "$checkout" in
    github.com/*)
      path="${checkout#github.com/}"
      owner="${path%%/*}"
      repo="${path#*/}"
      [ -n "$owner" ] && [ -n "$repo" ] && [ "$repo" != "$path" ] \
        || fail "repository pattern must use github.com/OWNER/REPO: $checkout"
      case "$repo" in
        */*) fail "repository pattern must identify exactly one GitHub repository: $checkout" ;;
      esac
      resolved=""
      pattern="github.com/$owner/$repo"
      ;;
    *)
      resolved="$(cd "$checkout" 2>/dev/null && pwd -P)" \
        || fail "could not resolve repository checkout: $checkout"
      pattern="$(github_pattern "$resolved")"
      ;;
  esac
  if [ "${#patterns[@]}" -gt 0 ]; then
    for existing in "${patterns[@]}"; do
      [ "$existing" != "$pattern" ] || fail "duplicate repository pattern: $pattern"
    done
  fi
  resolved_repos+=("$resolved")
  patterns+=("$pattern")
done
patterns_csv="$(IFS=,; printf '%s' "${patterns[*]}")"

config_dir="$HOME/.config/dotfiles"
git_include="$config_dir/github-app.gitconfig"
[ -d "$config_dir" ] && [ ! -L "$config_dir" ] || fail "missing canonical dotfiles config directory: $config_dir"
[ "$(uid_of "$config_dir")" = "$(id -u)" ] || fail "dotfiles config directory is not owned by the current user: $config_dir"
[ "$(mode_of "$config_dir")" = 700 ] || fail "dotfiles config directory must have mode 0700: $config_dir"

include_paths="$(git config --global --get-all include.path 2>/dev/null || true)"
printf -v github_app_include_path '%s%s' '~' '/.config/dotfiles/github-app.gitconfig'
printf '%s\n' "$include_paths" | grep -Fqx "$github_app_include_path" \
  || fail "assistant Git base does not include ~/.config/dotfiles/github-app.gitconfig; reapply the assistant profile"

tmp_include="$(mktemp "$config_dir/.github-app.gitconfig.XXXXXX")"
cleanup() {
  [ ! -e "$tmp_include" ] || rm -f -- "$tmp_include"
}
trap cleanup EXIT HUP INT TERM
printf -v app_auth_binary_q '%q' "$app_auth_binary"
helper="!$app_auth_binary_q git-credential"
git config --file "$tmp_include" --add credential.https://github.com.helper ''
git config --file "$tmp_include" --add credential.https://github.com.helper "$helper"
git config --file "$tmp_include" credential.https://github.com.useHttpPath true
chmod 0600 "$tmp_include"

if [ "$mode" = configure ]; then
  gh app-auth setup \
    --app-id "$app_id" \
    --installation-id "$installation_id" \
    --key-file "$key_file" \
    --patterns "$patterns_csv" \
    --name "$app_name" \
    --use-filesystem >/dev/null
  if [ -e "$git_include" ] || [ -L "$git_include" ]; then
    validate_owner_only_file "assistant GitHub App include" "$git_include"
  fi
  mv -f -- "$tmp_include" "$git_include"
  trap - EXIT HUP INT TERM
else
  validate_owner_only_file "assistant GitHub App include" "$git_include"
  cmp -s "$tmp_include" "$git_include" \
    || fail "assistant GitHub App include does not match the expected helper contract; rerun without --check"
fi

if gh auth status --hostname github.com >/dev/null 2>&1; then
  fail "a human gh auth login exists; remove it before using the assistant GitHub App identity"
fi

app_row="$(gh app-auth list | awk -F '\t' -v name="$app_name" -v app="$app_id" -v installation="$installation_id" '
  $1 == name && $2 == app && $3 == installation { print; found = 1 }
  END { if (!found) exit 1 }
')" || fail "gh-app-auth does not contain the expected App and installation"
configured_patterns="$(printf '%s\n' "$app_row" | awk -F '\t' '{ print $4 }' | tr -d ' ')"
[ "$configured_patterns" = "$patterns_csv" ] \
  || fail "gh-app-auth repository patterns differ from the requested exact set"

index=0
for pattern in "${patterns[@]}"; do
  checkout="${resolved_repos[$index]}"
  expected_repo="${pattern#github.com/}"
  gh app-auth test --repo "$pattern" >/dev/null \
    || fail "GitHub App authentication failed for $pattern"
  actual_repo="$(gh app-auth exec --repo "$pattern" -- gh api "repos/$expected_repo" --jq .full_name)" \
    || fail "GitHub API access failed for $pattern"
  [ "$actual_repo" = "$expected_repo" ] || fail "GitHub API returned the wrong repository for $pattern"
  if [ -n "$checkout" ]; then
    GIT_TERMINAL_PROMPT=0 git -C "$checkout" ls-remote origin HEAD >/dev/null \
      || fail "Git authentication failed for $pattern"
  fi
  index=$((index + 1))
done

printf 'ok assistant GitHub App %s is configured for %s exact repositories\n' \
  "$app_name" "${#patterns[@]}"
