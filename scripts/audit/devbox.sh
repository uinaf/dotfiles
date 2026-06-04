#!/usr/bin/env bash
set -euo pipefail

config_path="${UINAF_DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
machine_config_path="${INFISICAL_MACHINE_CONFIG:-$HOME/.config/uinaf/infisical-machine.env}"
devbox_user="${UINAF_DEVBOX_USER:-$USER}"
process_compose_enabled="${PROCESS_COMPOSE_ENABLED:-1}"
process_compose_port="${PROCESS_COMPOSE_PORT:-9191}"
process_compose_socket="${PROCESS_COMPOSE_SOCKET:-}"
infisical_domain="${INFISICAL_DOMAIN:-https://eu.infisical.com/api}"
json_output=0
warn_count=0
fail_count=0
secret_scan_count=0
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/lib/audit.sh
. "$repo_root/scripts/lib/audit.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/audit/devbox.sh [options]

Runs a non-destructive devbox drift audit for the current Unix user.

Options:
  --config PATH                 local devbox config, default: ~/.config/uinaf/devbox.env
  --json                        print a machine-readable summary instead of prose
  -h, --help

The script checks secret boundaries, process-compose isolation, Git/GitHub
identity state, SSH key permissions, and common stale secret backup locations.
Treat prose scanner output as sensitive because maintained scanners can include
matched secret material when they detect a leak. Use --json for compact remote
collection.
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
  printf ',"secret_scan_count":%s}\n' "$secret_scan_count"
}

emit_app_runtime_boundary_files() {
  find_matching_files "$HOME/.openclaw" \
    \( -path "$HOME/.openclaw/agents" \
      -o -path "$HOME/.openclaw/browser" \
      -o -path "$HOME/.openclaw/credentials" \
      -o -path "$HOME/.openclaw/devices" \
      -o -path "$HOME/.openclaw/identity" \
      -o -path "$HOME/.openclaw/plugin-runtime-deps" \
      -o -path "$HOME/.openclaw/plugin-runtime-deps.*" \
      -o -path "$HOME/.openclaw/service-env" \
      -o -path '*/node_modules' \
      -o -path '*/.tmp' \) -prune \
    -o -type f \( -name '*.bak' -o -name '*.last-good' -o -name '*.env.*' \)
}

emit_devbox_secret_scan_paths() {
  emit_home_dotfiles
  emit_app_runtime_boundary_files
  emit_path_if_exists "$HOME/.aws"
  emit_path_if_exists "$HOME/.config/process-compose"
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

check_app_service_env_boundary() {
  local service_env_dir="$HOME/.openclaw/service-env"
  local service_env_file
  local env_owner

  section "application service env boundary"

  if [ ! -e "$service_env_dir" ]; then
    ok "no optional application service env directory"
    return
  fi

  check_mode_any fail "$service_env_dir" 700
  if [ "$(owner_of "$service_env_dir")" = "$devbox_user" ]; then
    ok "$service_env_dir owner $devbox_user"
  else
    fail_check "$service_env_dir owner is $(owner_of "$service_env_dir"), expected $devbox_user"
  fi

  while IFS= read -r service_env_file; do
    [ -n "$service_env_file" ] || continue

    if [ -L "$service_env_file" ]; then
      fail_check "$service_env_file must not be a symlink"
      continue
    fi

    check_mode_any fail "$service_env_file" 600
    env_owner="$(owner_of "$service_env_file")"
    if [ "$env_owner" = "$devbox_user" ]; then
      ok "$service_env_file owner $env_owner"
    else
      fail_check "$service_env_file owner is $env_owner, expected $devbox_user"
    fi
  done < <(find "$service_env_dir" -maxdepth 1 -type f -name '*.env' -print 2>/dev/null | sort)
}

check_openclaw_runtime_env_boundary() {
  local env_file="$HOME/.openclaw/.env"
  local env_owner

  section "OpenClaw runtime env boundary"

  if [ ! -e "$env_file" ]; then
    if [ -e "$HOME/.openclaw" ]; then
      warn "OpenClaw state exists but $env_file is missing"
    else
      ok "no optional OpenClaw runtime env file"
    fi
    return
  fi

  if [ -L "$env_file" ]; then
    fail_check "$env_file must be a direct file, not a symlink"
    return
  fi

  check_mode_any fail "$env_file" 600
  env_owner="$(owner_of "$env_file")"
  if [ "$env_owner" = "$devbox_user" ]; then
    ok "$env_file owner $env_owner"
  else
    fail_check "$env_file owner is $env_owner, expected $devbox_user"
  fi
}

emit_openclaw_owned_paths() {
  local node_installs_dir="$HOME/.local/share/mise/installs/node"

  emit_path_if_exists "$HOME/.npm"
  emit_path_if_exists "$HOME/.openclaw"

  if [ -d "$node_installs_dir" ]; then
    find "$node_installs_dir" \
      \( -path '*/lib/node_modules/openclaw' -o -path '*/bin/openclaw' \) \
      -print 2>/dev/null || true
  fi
}

check_openclaw_owned_path() {
  local path="$1"
  local bad_path

  [ -e "$path" ] || return

  bad_path="$(
    find "$path" -maxdepth 8 \( -user root -o ! -user "$devbox_user" \) -print -quit 2>/dev/null || true
  )"
  if [ -n "$bad_path" ]; then
    fail_check "OpenClaw path contains root/non-$devbox_user-owned file: $bad_path"
  else
    ok "$path ownership stays with $devbox_user"
  fi
}

json_config_value() {
  local path="$1"
  local key="$2"

  if [ -r "$path" ] && command -v plutil >/dev/null 2>&1; then
    plutil -extract "$key" raw -o - "$path" 2>/dev/null | tr -d '\n' || true
  fi
}

check_openclaw_tmp() {
  if [ "$(owner_of /private/tmp 2>/dev/null || true)" != "root" ]; then
    fail_check "/private/tmp owner is $(owner_of /private/tmp 2>/dev/null || echo unknown), expected root"
  else
    ok "/private/tmp owner root"
  fi

  if [ "$(mode_of /private/tmp 2>/dev/null || true)" != "777" ]; then
    fail_check "/private/tmp mode is $(mode_of /private/tmp 2>/dev/null || echo unknown), expected 777 with sticky bit"
  else
    ok "/private/tmp mode 777"
  fi

  if [ -k /private/tmp ]; then
    ok "/private/tmp sticky bit set"
  else
    fail_check "/private/tmp sticky bit is not set"
  fi
}

check_openclaw_service_node() {
  local plist_path="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
  local wrapper_path="$HOME/.local/bin/openclaw-gateway-mise-wrapper"
  local path
  local checked=0

  if [ ! -e "$HOME/.openclaw" ] && ! command -v openclaw >/dev/null 2>&1; then
    ok "OpenClaw is not installed for this user"
    return
  fi

  if [ ! -e "$plist_path" ]; then
    warn "OpenClaw state exists but gateway LaunchAgent is not installed"
    return
  fi

  check_mode_any fail "$plist_path" 600

  for path in "$plist_path" "$wrapper_path"; do
    [ -e "$path" ] || continue
    checked=$((checked + 1))

    if grep -Eq '/opt/homebrew/(opt/)?node.*/bin/node|/opt/homebrew/bin/node' "$path"; then
      fail_check "$path references Homebrew Node"
    else
      ok "$path does not reference Homebrew Node"
    fi

    if grep -Eq "$HOME/.local/share/mise/installs/node|mise" "$path"; then
      ok "$path references mise"
    fi
  done

  if [ "$checked" -eq 1 ]; then
    warn "OpenClaw gateway wrapper is missing; checked LaunchAgent only"
  fi
}

check_openclaw_tailscale_serve() {
  local config_path="$HOME/.openclaw/openclaw.json"
  local gateway_port
  local tailscale_reset_on_exit
  local serve_status

  if [ ! -e "$config_path" ]; then
    ok "no OpenClaw config for Tailscale check"
    return
  fi

  gateway_port="$(json_config_value "$config_path" "gateway.port")"
  gateway_port="${gateway_port:-18789}"
  tailscale_reset_on_exit="$(json_config_value "$config_path" "gateway.tailscale.resetOnExit")"

  if ! command -v tailscale >/dev/null 2>&1; then
    warn "tailscale is missing for OpenClaw Serve drift check"
    return
  fi

  serve_status="$(tailscale serve status 2>/dev/null || true)"
  if ! grep -Fq "http://127.0.0.1:$gateway_port" <<< "$serve_status"; then
    ok "no Tailscale Serve route for OpenClaw port $gateway_port"
  elif [ "$tailscale_reset_on_exit" = "true" ]; then
    ok "OpenClaw resets Tailscale Serve for gateway port $gateway_port"
  else
    fail_check "Tailscale Serve proxies OpenClaw port $gateway_port but OpenClaw resetOnExit is not enabled"
  fi
}

check_openclaw_drift() {
  local path

  section "OpenClaw runtime drift"

  check_openclaw_tmp
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    check_openclaw_owned_path "$path"
  done < <(emit_openclaw_owned_paths | sort -u)

  check_openclaw_service_node
  check_openclaw_tailscale_serve
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

section "local devbox config"

if [ -e "$config_path" ]; then
  check_mode_any fail "$config_path" 600
  # shellcheck disable=SC1090
  . "$config_path"
  devbox_user="${UINAF_DEVBOX_USER:-$devbox_user}"
  process_compose_enabled="${PROCESS_COMPOSE_ENABLED:-$process_compose_enabled}"
  process_compose_port="${PROCESS_COMPOSE_PORT:-$process_compose_port}"
  process_compose_socket="${PROCESS_COMPOSE_SOCKET:-$process_compose_socket}"
  infisical_domain="${INFISICAL_DOMAIN:-$infisical_domain}"
else
  warn "missing optional $config_path; using defaults"
fi

if [ "$devbox_user" != "$USER" ]; then
  warn "UINAF_DEVBOX_USER is $devbox_user but current user is $USER"
else
  ok "devbox user matches current user: $devbox_user"
fi

load_uinaf_audit_policy

section "default shell secret boundary"

if [ -z "${INFISICAL_TOKEN+x}" ] \
  && [ -z "${INFISICAL_CLIENT_ID+x}" ] \
  && [ -z "${INFISICAL_CLIENT_SECRET+x}" ]; then
  ok "current shell does not export Infisical auth material"
else
  fail_check "current shell exports Infisical auth material"
fi

if [ "$json_output" -eq 1 ]; then
  zsh_login_has_no_infisical_token="$(zsh -lic 'test -z "${INFISICAL_TOKEN+x}" && test -z "${INFISICAL_CLIENT_ID+x}" && test -z "${INFISICAL_CLIENT_SECRET+x}"' >/dev/null 2>&1; printf '%s' "$?")"
elif zsh -lic 'test -z "${INFISICAL_TOKEN+x}" && test -z "${INFISICAL_CLIENT_ID+x}" && test -z "${INFISICAL_CLIENT_SECRET+x}"'; then
  zsh_login_has_no_infisical_token=0
else
  zsh_login_has_no_infisical_token=1
fi

if [ "$zsh_login_has_no_infisical_token" = "0" ]; then
  ok "login shell does not export Infisical auth material"
else
  fail_check "login shell exports Infisical auth material"
fi

section "infisical"

if command -v infisical >/dev/null 2>&1; then
  infisical_status_exit=0
  ok "infisical CLI is installed"

  set +e
  infisical_status_json="$(infisical login status --domain "$infisical_domain" --json 2>/dev/null)"
  infisical_status_exit=$?
  set -e
  if [ -z "$infisical_status_json" ] || ! printf '%s\n' "$infisical_status_json" | grep -q '"sessions"'; then
    fail_check "could not inspect Infisical login status"
  elif printf '%s\n' "$infisical_status_json" \
    | tr -d '\n' \
    | grep -Eq '"principalType"[[:space:]]*:[[:space:]]*"user"[^}]*"status"[[:space:]]*:[[:space:]]*"authenticated"|"status"[[:space:]]*:[[:space:]]*"authenticated"[^}]*"principalType"[[:space:]]*:[[:space:]]*"user"'; then
    fail_check "Infisical CLI has an authenticated human user session"
  elif [ "$infisical_status_exit" -eq 0 ]; then
    ok "no authenticated Infisical human user session"
  else
    ok "no authenticated Infisical human user session; status returned nonzero for inactive/expired session"
  fi
else
  fail_check "infisical CLI is missing"
fi

if [ -e "$machine_config_path" ]; then
  check_mode_any fail "$machine_config_path" 600
  ok "Infisical machine config is owner-only"
else
  warn "missing optional $machine_config_path"
fi

section "process-compose boundary"

if [ "$process_compose_enabled" = "0" ]; then
  ok "process-compose check disabled"
elif ! command -v process-compose >/dev/null 2>&1; then
  fail_check "process-compose is missing"
elif [ -n "$process_compose_socket" ]; then
  if process-compose --use-uds --unix-socket "$process_compose_socket" process list >/dev/null 2>&1; then
    ok "process-compose responds on socket $process_compose_socket"
  else
    fail_check "process-compose is not responding on socket $process_compose_socket"
  fi
else
  warn "using process-compose TCP port; prefer PROCESS_COMPOSE_SOCKET"
  if process-compose --port "$process_compose_port" process list >/dev/null 2>&1; then
    ok "process-compose responds on port $process_compose_port"
  else
    fail_check "process-compose is not responding on port $process_compose_port"
  fi
fi

section "local config secret scan"

scan_files_for_secrets < <(
  emit_devbox_secret_scan_paths | sort -u
)

if [ -e "$HOME/.docker/config.json" ]; then
  scan_file_for_secret_pattern "$HOME/.docker/config.json" '"auth"[[:space:]]*:' "inline Docker auth material"
fi

check_app_service_env_boundary
check_openclaw_runtime_env_boundary
check_openclaw_drift

section "Codex trust boundaries"

codex_config="$HOME/.codex/config.toml"
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

for path in "$HOME/projects/uinaf" "$HOME/projects/$devbox_user"; do
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

git_name="$(git config --get user.name 2>/dev/null || true)"
git_email="$(git config --get user.email 2>/dev/null || true)"
git_signing_key="$(git config --get user.signingkey 2>/dev/null || true)"
git_gpgsign="$(git config --get commit.gpgsign 2>/dev/null || true)"

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

if [ -d "$HOME/.ssh" ]; then
  while IFS= read -r key_path; do
    [ -n "$key_path" ] || continue
    key_mode="$(mode_of "$key_path")"
    if [ $((8#$key_mode & 0077)) -eq 0 ]; then
      ok "$key_path mode $key_mode"
    else
      fail_check "$key_path mode $key_mode is group/world accessible"
    fi
  done < <(find "$HOME/.ssh" -maxdepth 1 -type f ! -name '*.pub' ! -name 'known_hosts*' ! -name 'config' -print 2>/dev/null | sort)
else
  warn "missing $HOME/.ssh"
fi

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
