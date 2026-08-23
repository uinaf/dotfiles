#!/usr/bin/env bash
set -euo pipefail

target_user=""
install_openclaw=0
allow_openclaw_restart=0
install_colima=0
install_t3_code=0
openclaw_wrapper=""
openclaw_port=18789
openclaw_wrapper_set=0
openclaw_port_set=0
t3_version=""
t3_working_directory=""
check_only=0
print_labels=0
launchd_namespace="${DOTFILES_LAUNCHD_NAMESPACE:-}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

# shellcheck source=scripts/lib/launchd.sh
. "$repo_root/scripts/lib/launchd.sh"
# shellcheck source=scripts/lib/devbox-service-common.sh
. "$repo_root/scripts/lib/devbox-service-common.sh"
# shellcheck source=scripts/lib/devbox-service-openclaw.sh
. "$repo_root/scripts/lib/devbox-service-openclaw.sh"
# shellcheck source=scripts/lib/devbox-service-colima.sh
. "$repo_root/scripts/lib/devbox-service-colima.sh"
# shellcheck source=scripts/lib/devbox-service-t3-code.sh
. "$repo_root/scripts/lib/devbox-service-t3-code.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/install-devbox-service-daemons.sh --user <name> [services]

Services:
  --openclaw         Run the user's OpenClaw gateway at system boot.
  --allow-openclaw-restart
                      Let the selected user restart only its exact system job.
  --colima           Run the user's colima-ensure script once at system boot.
  --t3-code          Run a pinned T3 Code server at system boot.

Options:
  --check            Verify the selected LaunchDaemons without changing them.
  --print-labels     Print the generic labels for the selected user and exit.
  --namespace NAME   Stable label namespace; defaults to local.dotfiles.
  --openclaw-wrapper PATH
                      Executable process wrapper for OpenClaw runtime secrets.
  --openclaw-port PORT
                      Per-user gateway port; defaults to 18789.
  --t3-version VERSION
                      Exact npm T3 Code version; requires --t3-code.
  --t3-working-directory PATH
                      Server working directory; defaults to the user's home.

The installer must run as root on macOS. It creates root-owned system
LaunchDaemons that drop privileges to the selected user. Conflicting
GUI-session LaunchAgents must be retired explicitly before installation.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user)
      [ "$#" -ge 2 ] || fail "--user requires a value"
      target_user="$2"
      shift
      ;;
    --openclaw)
      install_openclaw=1
      ;;
    --allow-openclaw-restart)
      allow_openclaw_restart=1
      ;;
    --openclaw-wrapper)
      [ "$#" -ge 2 ] || fail "--openclaw-wrapper requires a value"
      openclaw_wrapper="$2"
      openclaw_wrapper_set=1
      shift
      ;;
    --openclaw-port)
      [ "$#" -ge 2 ] || fail "--openclaw-port requires a value"
      openclaw_port="$2"
      openclaw_port_set=1
      shift
      ;;
    --colima)
      install_colima=1
      ;;
    --t3-code)
      install_t3_code=1
      ;;
    --t3-version)
      [ "$#" -ge 2 ] || fail "--t3-version requires a value"
      t3_version="$2"
      shift
      ;;
    --t3-working-directory)
      [ "$#" -ge 2 ] || fail "--t3-working-directory requires a value"
      t3_working_directory="$2"
      shift
      ;;
    --check)
      check_only=1
      ;;
    --print-labels)
      print_labels=1
      ;;
    --namespace)
      [ "$#" -ge 2 ] || fail "--namespace requires a value"
      launchd_namespace="$2"
      shift
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

[ -n "$target_user" ] || fail "--user is required"
case "$target_user" in
  *[!A-Za-z0-9._-]*) fail "unsupported user name: $target_user" ;;
esac
if [ "$print_labels" -eq 1 ]; then
  if [ "$(uname -s)" = Darwin ] \
    && target_uid="$(id -u "$target_user" 2>/dev/null)"; then
    target_home="$(dscl . -read "/Users/$target_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
    [ -n "$target_home" ] && [ -d "$target_home" ] || fail "missing home for $target_user"
    launchd_namespace_file="$target_home/.config/dotfiles/launchd-namespace"
    if ! launchd_namespace="$(dotfiles_resolve_launchd_namespace_contract "$launchd_namespace" "$launchd_namespace_file" "$target_uid")"; then
      fail "invalid or conflicting stored LaunchDaemon namespace contract"
    fi
  elif ! launchd_namespace="$(dotfiles_resolve_launchd_namespace "$launchd_namespace")"; then
    fail "LaunchDaemon namespace must contain dot-separated letters, numbers, hyphens, or underscores"
  fi
  openclaw_label="$(dotfiles_launchd_label openclaw-gateway "$target_user" "$launchd_namespace")"
  colima_label="$(dotfiles_launchd_label colima "$target_user" "$launchd_namespace")"
  t3_label="$(dotfiles_launchd_label t3-code "$target_user" "$launchd_namespace")"
  printf '%s\n%s\n%s\n' "$openclaw_label" "$colima_label" "$t3_label"
  exit 0
fi

[ "$(uname -s)" = Darwin ] || fail "this installer supports macOS only"
[ "$install_openclaw" -eq 1 ] || [ "$allow_openclaw_restart" -eq 1 ] \
  || [ "$install_colima" -eq 1 ] \
  || [ "$install_t3_code" -eq 1 ] \
  || fail "select at least one service"
if [ "$install_openclaw" -ne 1 ] \
  && { [ "$openclaw_wrapper_set" -eq 1 ] || [ "$openclaw_port_set" -eq 1 ]; }; then
  fail "--openclaw-wrapper and --openclaw-port require --openclaw"
fi
if [ "$install_t3_code" -ne 1 ] \
  && { [ -n "$t3_version" ] || [ -n "$t3_working_directory" ]; }; then
  fail "--t3-version and --t3-working-directory require --t3-code"
fi
if [ "$install_t3_code" -eq 1 ] && [ -z "$t3_version" ]; then
  fail "--t3-code requires --t3-version"
fi
case "$openclaw_port" in
  ''|*[!0-9]*) fail "OpenClaw port must be an integer" ;;
esac
[ "${#openclaw_port}" -le 5 ] \
  || fail "OpenClaw port must be between 1 and 65535"
[ "$openclaw_port" -ge 1 ] && [ "$openclaw_port" -le 65535 ] \
  || fail "OpenClaw port must be between 1 and 65535"
if [ -n "$openclaw_wrapper" ]; then
  case "$openclaw_wrapper" in
    /*) ;;
    *) fail "OpenClaw wrapper must be an absolute path" ;;
  esac
fi

target_uid="$(id -u "$target_user" 2>/dev/null)" || fail "unknown user: $target_user"
target_group="$(id -gn "$target_user")"
target_home="$(dscl . -read "/Users/$target_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
[ -n "$target_home" ] && [ -d "$target_home" ] || fail "missing home for $target_user"
launchd_namespace_file="$target_home/.config/dotfiles/launchd-namespace"
if launchd_namespace="$(dotfiles_resolve_launchd_namespace_contract "$launchd_namespace" "$launchd_namespace_file" "$target_uid")"; then
  :
else
  namespace_status=$?
  if [ "$namespace_status" -eq 3 ]; then
    fail "LaunchDaemon namespace differs from the stored host contract"
  fi
  fail "LaunchDaemon namespace must contain dot-separated letters, numbers, hyphens, or underscores"
fi
openclaw_label="$(dotfiles_launchd_label openclaw-gateway "$target_user" "$launchd_namespace")"
colima_label="$(dotfiles_launchd_label colima "$target_user" "$launchd_namespace")"
t3_label="$(dotfiles_launchd_label t3-code "$target_user" "$launchd_namespace")"
[ -n "$t3_working_directory" ] || t3_working_directory="$target_home"

launch_daemon_dir="/Library/LaunchDaemons"
sudoers_dir="/etc/sudoers.d"
openclaw_restart_sudoers="$sudoers_dir/$(
  dotfiles_openclaw_restart_sudoers_name "$target_user" "$target_uid"
)"
colima_start="$target_home/.local/bin/colima-ensure"
colima_binary=""

if [ "$install_colima" -eq 1 ] && needs_target_files; then
  prepare_colima_service
fi
if [ "$install_t3_code" -eq 1 ]; then
  resolve_t3_code_service
fi

if [ "$check_only" -eq 1 ]; then
  if [ "$install_openclaw" -eq 1 ]; then
    check_job "$openclaw_label"
  fi
  if [ "$allow_openclaw_restart" -eq 1 ]; then
    check_openclaw_restart_sudoers
  fi
  if [ "$install_colima" -eq 1 ]; then
    check_colima
  fi
  if [ "$install_t3_code" -eq 1 ]; then
    check_t3_code
  fi
  exit 0
fi

[ "$(id -u)" -eq 0 ] || fail "run this installer as root"
command -v plutil >/dev/null || fail "missing plutil"
command -v launchctl >/dev/null || fail "missing launchctl"
[ "$allow_openclaw_restart" -eq 0 ] || [ -x /usr/sbin/visudo ] \
  || fail "missing /usr/sbin/visudo"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-service-daemons.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

if [ "$install_openclaw" -eq 1 ]; then
  prepare_openclaw_service
fi
if [ "$install_t3_code" -eq 1 ]; then
  prepare_t3_code_service
fi
persist_launchd_namespace

if [ "$install_openclaw" -eq 1 ]; then
  install_openclaw_service
fi
if [ "$allow_openclaw_restart" -eq 1 ]; then
  install_openclaw_restart_policy
fi
if [ "$install_colima" -eq 1 ]; then
  install_colima_service
fi
if [ "$install_t3_code" -eq 1 ]; then
  install_t3_code_service
fi

printf 'devbox service daemon installation ok\n'
