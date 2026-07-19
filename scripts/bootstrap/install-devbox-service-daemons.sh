#!/usr/bin/env bash
set -euo pipefail

target_user=""
install_process_compose=0
install_openclaw=0
check_only=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/install-devbox-service-daemons.sh --user <name> [services]

Services:
  --process-compose  Run the user's process-compose supervisor at system boot.
  --openclaw         Run the user's OpenClaw gateway at system boot.

Options:
  --check            Verify the selected LaunchDaemons without changing them.

The installer must run as root on macOS. It creates root-owned system
LaunchDaemons that drop privileges to the selected user, then retires the
equivalent GUI-session LaunchAgents after the system jobs load successfully.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user)
      [ "$#" -ge 2 ] || fail "--user requires a value"
      target_user="$2"
      shift
      ;;
    --process-compose)
      install_process_compose=1
      ;;
    --openclaw)
      install_openclaw=1
      ;;
    --check)
      check_only=1
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

[ "$(uname -s)" = "Darwin" ] || fail "this installer supports macOS only"
[ -n "$target_user" ] || fail "--user is required"
case "$target_user" in
  *[!A-Za-z0-9._-]*) fail "unsupported user name: $target_user" ;;
esac
[ "$install_process_compose" -eq 1 ] || [ "$install_openclaw" -eq 1 ] \
  || fail "select at least one service"

target_uid="$(id -u "$target_user" 2>/dev/null)" || fail "unknown user: $target_user"
target_group="$(id -gn "$target_user")"
target_home="$(dscl . -read "/Users/$target_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
[ -n "$target_home" ] && [ -d "$target_home" ] || fail "missing home for $target_user"

process_label="com.uinaf.process-compose.$target_user"
openclaw_label="com.uinaf.openclaw-gateway.$target_user"
launch_daemon_dir="/Library/LaunchDaemons"

check_job() {
  local label="$1"
  local retired_agent="$2"

  [ -f "$launch_daemon_dir/$label.plist" ] || fail "missing $launch_daemon_dir/$label.plist"
  [ "$(stat -f '%Su:%Sg:%Lp' "$launch_daemon_dir/$label.plist")" = "root:wheel:644" ] \
    || fail "$label plist must be root:wheel mode 0644"
  launchctl print "system/$label" >/dev/null 2>&1 || fail "$label is not loaded"
  [ ! -e "$target_home/Library/LaunchAgents/$retired_agent.plist" ] \
    || fail "conflicting LaunchAgent remains: $retired_agent"
  printf 'ok %s loaded for %s\n' "$label" "$target_user"
}

if [ "$check_only" -eq 1 ]; then
  if [ "$install_process_compose" -eq 1 ]; then
    check_job "$process_label" com.uinaf.process-compose
  fi
  if [ "$install_openclaw" -eq 1 ]; then
    check_job "$openclaw_label" ai.openclaw.gateway
  fi
  exit 0
fi

[ "$(id -u)" -eq 0 ] || fail "run this installer as root"
command -v plutil >/dev/null || fail "missing plutil"
command -v launchctl >/dev/null || fail "missing launchctl"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/uinaf-service-daemons.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

plist_add_arguments() {
  local plist="$1"
  shift
  local index=0
  local argument

  plutil -insert ProgramArguments -xml '<array></array>' "$plist"
  for argument in "$@"; do
    plutil -insert "ProgramArguments.$index" -string "$argument" "$plist"
    index=$((index + 1))
  done
}

create_plist() {
  local plist="$1"
  local label="$2"
  local working_directory="$3"
  local stdout_path="$4"
  local stderr_path="$5"
  shift 5

  plutil -create xml1 "$plist"
  plutil -insert Label -string "$label" "$plist"
  plutil -insert UserName -string "$target_user" "$plist"
  plutil -insert GroupName -string "$target_group" "$plist"
  plutil -insert WorkingDirectory -string "$working_directory" "$plist"
  plutil -insert RunAtLoad -bool true "$plist"
  plutil -insert KeepAlive -bool true "$plist"
  plutil -insert SessionCreate -bool true "$plist"
  plutil -insert ThrottleInterval -integer 10 "$plist"
  plutil -insert Umask -integer 63 "$plist"
  plutil -insert StandardOutPath -string "$stdout_path" "$plist"
  plutil -insert StandardErrorPath -string "$stderr_path" "$plist"
  plist_add_arguments "$plist" "$@"
  plutil -lint "$plist" >/dev/null
}

install_job() {
  local source_plist="$1"
  local label="$2"
  local old_agent_label="$3"
  local old_agent_path="$target_home/Library/LaunchAgents/$old_agent_label.plist"
  local retired_dir="$target_home/Library/LaunchAgents.disabled"
  local retired_path="$retired_dir/$old_agent_label.plist"

  launchctl bootout "system/$label" >/dev/null 2>&1 || true
  install -o root -g wheel -m 0644 "$source_plist" "$launch_daemon_dir/$label.plist"
  launchctl bootstrap system "$launch_daemon_dir/$label.plist"
  launchctl enable "system/$label"
  launchctl kickstart -k "system/$label"
  launchctl print "system/$label" >/dev/null

  launchctl bootout "gui/$target_uid/$old_agent_label" >/dev/null 2>&1 || true
  launchctl bootout "user/$target_uid/$old_agent_label" >/dev/null 2>&1 || true
  if [ -e "$old_agent_path" ]; then
    install -d -o "$target_user" -g "$target_group" -m 0700 "$retired_dir"
    [ ! -e "$retired_path" ] || fail "retired LaunchAgent already exists: $retired_path"
    mv "$old_agent_path" "$retired_path"
    chown "$target_user:$target_group" "$retired_path"
    chmod 0600 "$retired_path"
  fi

  printf 'installed %s for %s\n' "$label" "$target_user"
}

if [ "$install_process_compose" -eq 1 ]; then
  process_start="$target_home/.local/bin/process-compose-start.sh"
  [ -x "$process_start" ] || fail "missing executable $process_start"
  install -d -o "$target_user" -g "$target_group" -m 0700 "$target_home/.local/run"
  install -d -o "$target_user" -g "$target_group" -m 0750 "$target_home/.local/log/process-compose"
  process_plist="$tmp_dir/$process_label.plist"
  create_plist \
    "$process_plist" \
    "$process_label" \
    "$target_home" \
    "$target_home/.local/log/process-compose/stdout.log" \
    "$target_home/.local/log/process-compose/stderr.log" \
    "$process_start"
  install_job "$process_plist" "$process_label" com.uinaf.process-compose
fi

if [ "$install_openclaw" -eq 1 ]; then
  env_wrapper="$target_home/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh"
  env_file="$target_home/.openclaw/service-env/ai.openclaw.gateway.env"
  gateway_wrapper="$target_home/.local/bin/openclaw-gateway-mise-wrapper"
  [ -x "$env_wrapper" ] || fail "missing executable $env_wrapper"
  [ -f "$env_file" ] || fail "missing $env_file"
  [ -x "$gateway_wrapper" ] || fail "missing executable $gateway_wrapper"
  install -d -o "$target_user" -g "$target_group" -m 0750 "$target_home/Library/Logs/openclaw"
  openclaw_plist="$tmp_dir/$openclaw_label.plist"
  create_plist \
    "$openclaw_plist" \
    "$openclaw_label" \
    "$target_home/.openclaw" \
    "$target_home/Library/Logs/openclaw/gateway.log" \
    "$target_home/Library/Logs/openclaw/gateway-error.log" \
    /bin/sh \
    "$env_wrapper" \
    "$env_file" \
    "$gateway_wrapper" \
    gateway \
    --port \
    18789
  install_job "$openclaw_plist" "$openclaw_label" ai.openclaw.gateway
fi

printf 'devbox service daemon installation ok\n'
