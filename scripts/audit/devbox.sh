#!/usr/bin/env bash
set -euo pipefail

config_path="${DEVBOX_CONFIG:-}"
devbox_user="${DEVBOX_USER:-$USER}"
json_output=0
warn_count=0
fail_count=0
secret_scan_count=0
secret_scan_finding_count=0
secret_scan_rules_json=
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/lib/audit.sh
. "$repo_root/scripts/lib/audit.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/audit/devbox.sh [options]

Runs a non-destructive devbox drift audit for the current Unix user.

Options:
  --config PATH                 local devbox config, default: ~/.config/dotfiles/devbox.env
  --json                        print a machine-readable summary instead of prose
  -h, --help

The script checks secret boundaries, Git/GitHub identity state, SSH key
permissions, and common stale secret backup locations. Local Gitleaks prose
output is sanitized to rule ID and staged relative path; --json adds aggregate
finding counts by rule. Other scanners may still emit matched material in prose,
so prefer --json for remote collection.
USAGE
}

print_json_summary() {
  local status="pass"
  if [ "$fail_count" -gt 0 ]; then
    status="fail"
  elif [ "$warn_count" -gt 0 ]; then
    status="warn"
  fi

  printf '{"audit":'
  json_string "devbox-security"
  printf ',"status":'
  json_string "$status"
  printf ',"failed":%s,"warnings":%s,"user":' "$fail_count" "$warn_count"
  json_string "$USER"
  printf ',"devbox_user":'
  json_string "$devbox_user"
  printf ',"secret_scan_count":%s' "$secret_scan_count"
  printf ',"secret_scan_finding_count":%s' "$secret_scan_finding_count"
  printf ',"secret_scan_rules":%s}\n' "$(secret_scan_rules_json_or_empty_object)"
}

emit_devbox_secret_scan_paths() {
  emit_home_dotfiles
  emit_path_if_exists "$HOME/.aws"
  emit_path_if_exists "$HOME/.docker"
  emit_path_if_exists "$HOME/.bash_sessions"
  emit_path_if_exists "$HOME/.zsh_sessions"
  emit_path_if_exists "$HOME/Library/LaunchAgents"
  emit_path_if_exists /Library/LaunchDaemons
  find_matching_files "$HOME/.ssh" -maxdepth 1 -type f -name 'config*'
}

list_codex_project_paths() {
  local config="$1"

  if [ -r "$config" ]; then
    sed -nE 's/^\[projects\."([^"]+)"\]$/\1/p' "$config"
  fi
}

tailscale_self_dns_name() {
  if ! command -v plutil >/dev/null 2>&1; then
    return 1
  fi

  tailscale status --json \
    | plutil -extract Self.DNSName raw -o - - 2>/dev/null \
    | tr -d '\n'
}

direct_magicdns_resolves() {
  local name="$1"

  if ! command -v dig >/dev/null 2>&1; then
    return 2
  fi

  dig +time=2 +tries=1 +short @100.100.100.100 "$name" A \
    | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$'
}

system_resolves_host() {
  local name="$1"

  if command -v dscacheutil >/dev/null 2>&1; then
    dscacheutil -q host -a name "$name" | grep -q '^ip_address:'
  elif command -v getent >/dev/null 2>&1; then
    getent hosts "$name" >/dev/null
  elif command -v host >/dev/null 2>&1; then
    host "$name" >/dev/null
  else
    return 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      config_path="${2:-}"
      shift 2
      ;;
    --json)
      json_output=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

config_path="$(dotfiles_resolve_config_file "$config_path" devbox.env)"

section "local devbox config"

if [ -e "$config_path" ]; then
  check_mode_any fail "$config_path" 600
  # shellcheck disable=SC1090
  . "$config_path"
  devbox_user="${DEVBOX_USER:-$devbox_user}"
else
  warn "missing optional $config_path; using defaults"
fi

if [ "$devbox_user" != "$USER" ]; then
  warn "DEVBOX_USER is $devbox_user but current user is $USER"
else
  ok "devbox user matches current user: $devbox_user"
fi

load_audit_policy

section "local config secret scan"

scan_files_for_secrets < <(
  emit_devbox_secret_scan_paths | sort -u
)

if [ -e "$HOME/.docker/config.json" ]; then
  scan_file_for_secret_pattern "$HOME/.docker/config.json" '"auth"[[:space:]]*:' "inline Docker auth material"
fi

section "Codex trust boundaries"

codex_config="$HOME/.codex/config.toml"
if [ -d "$HOME/.codex" ]; then
  check_mode_any fail "$HOME/.codex" 700

  for codex_dir in \
    "$HOME/.codex/sessions" \
    "$HOME/.codex/archived_sessions" \
    "$HOME/.codex/shell_snapshots" \
    "$HOME/.codex/log" \
    "$HOME/.codex/app-server-control"; do
    if [ -d "$codex_dir" ]; then
      check_mode_any fail "$codex_dir" 700
    fi
  done

  while IFS= read -r codex_state_file; do
    [ -n "$codex_state_file" ] || continue
    codex_state_mode="$(mode_of "$codex_state_file")"
    if [ $((8#$codex_state_mode & 0077)) -eq 0 ]; then
      ok "$codex_state_file mode $codex_state_mode"
    else
      fail_check "$codex_state_file mode $codex_state_mode is group/world accessible"
    fi
  done < <(
    find "$HOME/.codex" -maxdepth 3 -type f \
      \( -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db' \
      -o -name '*.db-*' -o -name '*.log' -o -path '*/log/*' \) \
      -print 2>/dev/null
  )
fi

if [ -e "$codex_config" ]; then
  check_mode_any fail "$codex_config" 600
  trusted_project_count=0
  home_parent="$(dirname "$HOME")"

  while IFS= read -r trusted_path; do
    [ -n "$trusted_path" ] || continue
    trusted_project_count=$((trusted_project_count + 1))

    if [ ! -e "$trusted_path" ]; then
      warn "Codex trusts missing project path: $trusted_path"
    fi

    case "$trusted_path" in
      "$HOME"|"$HOME/projects")
        warn "Codex trusts broad home path: $trusted_path"
        ;;
      "$HOME"/*)
        ok "Codex trusted path stays under this user: $trusted_path"
        ;;
      "$home_parent"/*)
        fail_check "Codex trusts another user's path: $trusted_path"
        ;;
      *)
        warn "Codex trusts path outside this home: $trusted_path"
        ;;
    esac
  done < <(list_codex_project_paths "$codex_config")

  if [ "$trusted_project_count" -eq 0 ]; then
    warn "Codex has no trusted project entries"
  fi
else
  warn "missing $codex_config"
fi

section "home root pollution"

for path in "$HOME/node_modules" "$HOME/package.json" "$HOME/package-lock.json" "$HOME/pnpm-lock.yaml" "$HOME/yarn.lock"; do
  if [ -e "$path" ]; then
    warn "home root contains project artifact: $path"
  fi
done

section "project directory privacy"

for path in "$HOME/projects" "$HOME/projects/$devbox_user"; do
  if [ -d "$path" ]; then
    mode="$(mode_of "$path")"
    if [ $((8#$mode & 0077)) -eq 0 ]; then
      ok "$path mode $mode"
    else
      warn "$path mode $mode is readable by group or other users"
    fi
  fi
done

section "Git and GitHub identity"

git_name="$(git config --file "$HOME/.gitconfig" --includes --get user.name 2>/dev/null || true)"
git_email="$(git config --file "$HOME/.gitconfig" --includes --get user.email 2>/dev/null || true)"
git_signing_key="$(git config --file "$HOME/.gitconfig" --includes --get user.signingkey 2>/dev/null || true)"
git_gpgsign="$(git config --file "$HOME/.gitconfig" --includes --get commit.gpgsign 2>/dev/null || true)"

[ -n "$git_name" ] || fail_check "missing git user.name"
[ -n "$git_email" ] || fail_check "missing git user.email"
[ -n "$git_signing_key" ] || fail_check "missing git user.signingkey"

if [ -n "$git_name" ] && [ -n "$git_email" ]; then
  ok "git identity configured"
fi

if [ "$git_gpgsign" = "true" ]; then
  ok "git commit signing enabled"
else
  fail_check "git commit signing is not enabled"
fi

if command -v gh >/dev/null 2>&1; then
  if gh auth status -h github.com >/dev/null 2>&1; then
    ok "gh auth works for github.com"
    warn_on_broad_gh_scopes
  else
    fail_check "gh auth is not working for github.com"
  fi
else
  fail_check "gh is missing"
fi

if command -v ssh >/dev/null 2>&1; then
  github_ssh_output="$(ssh -o BatchMode=yes -T git@github.com 2>&1 || true)"
  if grep -q 'successfully authenticated' <<< "$github_ssh_output"; then
    ok "git@github.com SSH auth works"
  else
    fail_check "git@github.com SSH auth failed"
  fi
else
  fail_check "ssh is missing"
fi

section "SSH key file permissions"

check_ssh_private_key_modes

section "Tailscale"

if command -v tailscale >/dev/null 2>&1; then
  if tailscale status --peers=false >/dev/null 2>&1; then
    ok "tailscale status works"

    tailscale_dns_name="$(tailscale_self_dns_name || true)"
    tailscale_dns_name="${tailscale_dns_name%.}"
    tailscale_short_name="${tailscale_dns_name%%.*}"

    if [ -z "$tailscale_dns_name" ] || [ "$tailscale_short_name" = "$tailscale_dns_name" ]; then
      fail_check "tailscale self DNS name is unavailable"
    elif direct_magicdns_resolves "$tailscale_dns_name"; then
      ok "direct MagicDNS lookup works through 100.100.100.100"

      if system_resolves_host "$tailscale_short_name"; then
        ok "system resolver handles MagicDNS short hostnames"
      elif system_resolves_host "$tailscale_dns_name"; then
        fail_check "system resolver handles MagicDNS FQDNs but not short hostnames"
      else
        fail_check "system resolver is not using Tailscale MagicDNS; repair Tailscale resolver wiring"
      fi
    else
      fail_check "direct MagicDNS lookup failed through 100.100.100.100"
    fi
  else
    fail_check "tailscale status failed"
  fi
else
  fail_check "tailscale is missing"
fi

if [ "$json_output" -eq 1 ]; then
  print_json_summary
else
  printf '\ndevbox security audit summary: %s failed, %s warnings\n' "$fail_count" "$warn_count"
fi

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
