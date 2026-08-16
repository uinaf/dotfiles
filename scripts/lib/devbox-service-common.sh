#!/usr/bin/env bash

# Populated by install-devbox-service-daemons.sh before these helpers run.
target_home="${target_home:-}"
target_uid="${target_uid:-}"
target_user="${target_user:-}"
target_group="${target_group:-}"
check_only="${check_only:-0}"
launch_daemon_dir="${launch_daemon_dir:-}"
launchd_namespace="${launchd_namespace:-}"
launchd_namespace_file="${launchd_namespace_file:-}"

find_executable() {
  local name="$1"
  local candidate
  for candidate in \
    "$target_home/.local/bin/$name" \
    "$target_home/.local/share/mise/shims/$name" \
    "/opt/homebrew/bin/$name" \
    "/usr/local/bin/$name"
  do
    [ ! -x "$candidate" ] || { printf '%s\n' "$candidate"; return; }
  done
  return 1
}

can_run_as_target() {
  [ "$(id -u)" -eq "$target_uid" ] || [ "$(id -u)" -eq 0 ]
}

run_as_target() {
  if [ "$(id -u)" -eq "$target_uid" ]; then
    "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    /usr/bin/sudo -u "$target_user" -H "$@"
  else
    fail "run this step as root or $target_user"
  fi
}

needs_target_files() {
  [ "$check_only" -eq 0 ] || can_run_as_target
}

check_job() {
  local label="$1"

  [ -f "$launch_daemon_dir/$label.plist" ] || fail "missing $launch_daemon_dir/$label.plist"
  [ "$(stat -f '%Su:%Sg:%Lp' "$launch_daemon_dir/$label.plist")" = "root:wheel:644" ] \
    || fail "$label plist must be root:wheel mode 0644"
  launchctl print "system/$label" >/dev/null 2>&1 || fail "$label is not loaded"
  printf 'ok %s loaded for %s\n' "$label" "$target_user"
}

persist_launchd_namespace() {
  local launchd_namespace_dir
  local namespace_tmp

  launchd_namespace_dir="$(dirname "$launchd_namespace_file")"
  run_as_target install -d -m 0700 "$launchd_namespace_dir"
  namespace_tmp="$(run_as_target mktemp "$launchd_namespace_dir/.launchd-namespace.XXXXXX")"
  printf '%s\n' "$launchd_namespace" | run_as_target tee "$namespace_tmp" >/dev/null
  run_as_target chmod 0600 "$namespace_tmp"
  run_as_target mv -f "$namespace_tmp" "$launchd_namespace_file"
}

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

bootout_if_loaded() {
  local domain="$1"
  local label="$2"

  if ! launchctl print "$domain/$label" >/dev/null 2>&1; then
    return 0
  fi
  launchctl bootout "$domain/$label" >/dev/null \
    || fail "could not unload $domain/$label"
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    fail "$domain/$label remains loaded after bootout"
  fi
}

install_job() {
  local source_plist="$1"
  local label="$2"

  bootout_if_loaded system "$label"
  install -o root -g wheel -m 0644 "$source_plist" "$launch_daemon_dir/$label.plist"
  launchctl bootstrap system "$launch_daemon_dir/$label.plist"
  launchctl enable "system/$label"
  launchctl kickstart -k "system/$label"
  launchctl print "system/$label" >/dev/null
  printf 'installed %s for %s\n' "$label" "$target_user"
}
