#!/usr/bin/env bash
set -euo pipefail

config_path="${UINAF_DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
devbox_user="${UINAF_DEVBOX_USER:-$USER}"
process_compose_enabled="${UINAF_PROCESS_COMPOSE_ENABLED:-1}"
process_compose_port="${UINAF_PROCESS_COMPOSE_PORT:-9191}"
process_compose_socket="${UINAF_PROCESS_COMPOSE_SOCKET:-}"
token_file="${UINAF_OP_SERVICE_ACCOUNT_TOKEN_FILE:-/var/db/uinaf/devbox-secrets/$devbox_user/op-sa-token}"
workspace_env_file="${UINAF_WORKSPACE_ENV_FILE:-/var/db/uinaf/devbox-env/$devbox_user/workspace.env}"
workspace_env_link="${UINAF_WORKSPACE_ENV_LINK:-}"
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
    -o -type f \( -name '*.env' -o -name '*.bak' -o -name '*.last-good' \)
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

json_config_value() {
  local path="$1"
  local key="$2"

  if [ -r "$path" ] && command -v plutil >/dev/null 2>&1; then
    plutil -extract "$key" raw -o - "$path" 2>/dev/null | tr -d '\n' || true
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

emit_openclaw_owned_paths() {
  local node_installs_dir="$HOME/.local/share/mise/installs/node"
  local npm_prefix

  emit_path_if_exists "$HOME/.npm"
  emit_path_if_exists "$HOME/.openclaw"

  if [ -d "$node_installs_dir" ]; then
    find "$node_installs_dir" -path '*/lib/node_modules/openclaw' -type d -print 2>/dev/null || true
    find "$node_installs_dir" -path '*/bin/openclaw' -print 2>/dev/null || true
  fi

  if command -v npm >/dev/null 2>&1; then
    npm_prefix="$(npm config get prefix 2>/dev/null || true)"
    if [ -n "$npm_prefix" ]; then
      emit_path_if_exists "$npm_prefix/lib/node_modules/openclaw"
      emit_path_if_exists "$npm_prefix/bin/openclaw"
    fi
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

check_private_tmp_for_openclaw() {
  section "OpenClaw temp directory boundary"

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

check_openclaw_gateway_wrapper() {
  local plist_path="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
  local wrapper_path="$HOME/.local/bin/openclaw-gateway-mise-wrapper"
  local expected_node=""
  local node_prefix=""
  local expected_entry=""
  local launchctl_output=""
  local gateway_pid=""
  local gateway_command=""

  section "OpenClaw gateway service"

  if [ ! -e "$HOME/.openclaw" ] && ! command -v openclaw >/dev/null 2>&1; then
    ok "OpenClaw is not installed for this user"
    return
  fi

  if [ ! -e "$plist_path" ]; then
    warn "OpenClaw state exists but gateway LaunchAgent is not installed"
    return
  fi

  check_mode_any fail "$plist_path" 600

  if grep -Fq "$wrapper_path" "$plist_path"; then
    ok "OpenClaw LaunchAgent uses mise wrapper"
  else
    fail_check "OpenClaw LaunchAgent does not use $wrapper_path"
  fi

  check_mode_any fail "$wrapper_path" 700
  if [ -x "$wrapper_path" ]; then
    ok "$wrapper_path is executable"
  else
    fail_check "$wrapper_path is not executable"
  fi

  if command -v mise >/dev/null 2>&1; then
    expected_node="$(mise which node 2>/dev/null || true)"
  fi

  if [ -z "$expected_node" ]; then
    fail_check "cannot resolve mise Node for OpenClaw gateway wrapper"
  elif grep -Fq "$expected_node" "$wrapper_path"; then
    ok "OpenClaw wrapper uses mise Node $expected_node"
  else
    fail_check "OpenClaw wrapper does not reference mise Node $expected_node"
  fi

  if [ -n "$expected_node" ]; then
    node_prefix="$(cd "$(dirname "$expected_node")/.." 2>/dev/null && pwd -P || true)"
    expected_entry="$node_prefix/lib/node_modules/openclaw/dist/index.js"
    if [ -n "$node_prefix" ] && grep -Fq "$expected_entry" "$wrapper_path"; then
      ok "OpenClaw wrapper uses mise-managed OpenClaw entrypoint"
    else
      fail_check "OpenClaw wrapper does not reference $expected_entry"
    fi
  fi

  if grep -Eq '/opt/homebrew/(opt/)?node.*/bin/node|/opt/homebrew/bin/node' "$plist_path" "$wrapper_path"; then
    fail_check "OpenClaw gateway service still references Homebrew Node"
  else
    ok "OpenClaw gateway service does not reference Homebrew Node"
  fi

  launchctl_output="$(launchctl print "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true)"
  gateway_pid="$(sed -nE 's/^[[:space:]]*pid = ([0-9]+)$/\1/p' <<< "$launchctl_output" | head -1)"
  if [ -n "$gateway_pid" ]; then
    gateway_command="$(ps -p "$gateway_pid" -o command= 2>/dev/null || true)"
    if [ -n "$expected_node" ] && grep -Fq "$expected_node" <<< "$gateway_command"; then
      ok "running OpenClaw gateway uses mise Node"
    else
      fail_check "running OpenClaw gateway does not use mise Node"
    fi
  else
    warn "OpenClaw gateway LaunchAgent is installed but not currently running"
  fi
}

check_openclaw_tailscale_boundary() {
  local config_path="$HOME/.openclaw/openclaw.json"
  local gateway_port
  local tailscale_mode
  local tailscale_reset_on_exit
  local serve_status

  section "OpenClaw Tailscale boundary"

  if [ ! -e "$config_path" ]; then
    ok "no OpenClaw config for Tailscale check"
    return
  fi

  gateway_port="$(json_config_value "$config_path" "gateway.port")"
  gateway_port="${gateway_port:-18789}"
  tailscale_mode="$(json_config_value "$config_path" "gateway.tailscale.mode")"
  tailscale_reset_on_exit="$(json_config_value "$config_path" "gateway.tailscale.resetOnExit")"

  if [ "$tailscale_mode" = "serve" ] && [ "$tailscale_reset_on_exit" = "true" ]; then
    ok "OpenClaw owns Tailscale Serve cleanup for gateway port $gateway_port"
  elif [ "$tailscale_mode" = "off" ] || [ -z "$tailscale_mode" ]; then
    ok "OpenClaw Tailscale mode is off"
  else
    warn "OpenClaw Tailscale mode is $tailscale_mode with resetOnExit=${tailscale_reset_on_exit:-unset}"
  fi

  if command -v tailscale >/dev/null 2>&1; then
    serve_status="$(tailscale serve status 2>/dev/null || true)"
    if grep -Fq "http://127.0.0.1:$gateway_port" <<< "$serve_status"; then
      if [ "$tailscale_mode" = "serve" ] && [ "$tailscale_reset_on_exit" = "true" ]; then
        ok "Tailscale Serve route for OpenClaw is managed by OpenClaw config"
      else
        fail_check "Tailscale Serve proxies OpenClaw port $gateway_port but OpenClaw resetOnExit is not enabled"
      fi
    else
      ok "no stale Tailscale Serve route for OpenClaw port $gateway_port"
    fi
  else
    warn "tailscale is missing for OpenClaw Serve drift check"
  fi
}

check_openclaw_drift() {
  local path

  check_private_tmp_for_openclaw

  section "OpenClaw ownership boundary"

  while IFS= read -r path; do
    [ -n "$path" ] || continue
    check_openclaw_owned_path "$path"
  done < <(emit_openclaw_owned_paths | sort -u)

  check_openclaw_gateway_wrapper
  check_openclaw_tailscale_boundary
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
  process_compose_enabled="${UINAF_PROCESS_COMPOSE_ENABLED:-$process_compose_enabled}"
  process_compose_port="${UINAF_PROCESS_COMPOSE_PORT:-$process_compose_port}"
  process_compose_socket="${UINAF_PROCESS_COMPOSE_SOCKET:-$process_compose_socket}"
  token_file="${UINAF_OP_SERVICE_ACCOUNT_TOKEN_FILE:-$token_file}"
  workspace_env_file="${UINAF_WORKSPACE_ENV_FILE:-$workspace_env_file}"
  workspace_env_link="${UINAF_WORKSPACE_ENV_LINK:-$workspace_env_link}"
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

if [ -z "${OP_SERVICE_ACCOUNT_TOKEN+x}" ]; then
  ok "current shell does not export OP_SERVICE_ACCOUNT_TOKEN"
else
  fail_check "current shell exports OP_SERVICE_ACCOUNT_TOKEN"
fi

if [ "$json_output" -eq 1 ]; then
  zsh_login_has_no_token="$(zsh -lic 'test -z "${OP_SERVICE_ACCOUNT_TOKEN+x}"' >/dev/null 2>&1; printf '%s' "$?")"
elif zsh -lic 'test -z "${OP_SERVICE_ACCOUNT_TOKEN+x}"'; then
  zsh_login_has_no_token=0
else
  zsh_login_has_no_token=1
fi

if [ "$zsh_login_has_no_token" = "0" ]; then
  ok "login shell does not export OP_SERVICE_ACCOUNT_TOKEN"
else
  fail_check "login shell exports OP_SERVICE_ACCOUNT_TOKEN"
fi

section "1Password service account token file"

if [ "$(id -u)" -ne 0 ] && [ ! -e "$token_file" ]; then
  ok "$token_file is not visible to this user; root-owned token storage is not exposed to the devbox shell"
else
  check_mode_any fail "$token_file" 400 600
  if [ -e "$token_file" ]; then
    if [ "$(owner_of "$token_file")" = "root" ]; then
      ok "$token_file is root-owned"
    else
      fail_check "$token_file must be root-owned"
    fi
  fi
fi

section "generated runtime env"

if [ -e "$workspace_env_file" ]; then
  env_dir="$(dirname "$workspace_env_file")"
  check_mode_any fail "$env_dir" 700 711
  check_mode_any fail "$workspace_env_file" 400 600

  if [ -L "$workspace_env_file" ]; then
    fail_check "$workspace_env_file must not be a symlink"
  fi

  env_owner="$(owner_of "$workspace_env_file")"
  if [ "$env_owner" = "$devbox_user" ]; then
    ok "$workspace_env_file owner $env_owner"
  else
    fail_check "$workspace_env_file owner is $env_owner, expected $devbox_user"
  fi
else
  warn "missing $workspace_env_file"
fi

if [ -n "$workspace_env_link" ]; then
  if [ -e "$workspace_env_link" ] || [ -L "$workspace_env_link" ]; then
    if [ -L "$workspace_env_link" ]; then
      link_target="$(readlink "$workspace_env_link")"
      if [ "$link_target" = "$workspace_env_file" ]; then
        ok "$workspace_env_link points to generated env"
      else
        fail_check "$workspace_env_link points to $link_target, expected $workspace_env_file"
      fi
    else
      fail_check "$workspace_env_link should be a symlink to the generated env"
    fi
  else
    fail_check "missing configured workspace env link $workspace_env_link"
  fi
else
  ok "no workspace env link configured"
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
  warn "using process-compose TCP port; prefer UINAF_PROCESS_COMPOSE_SOCKET"
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
