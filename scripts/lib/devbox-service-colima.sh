#!/usr/bin/env bash

# Populated by install-devbox-service-daemons.sh before these helpers run.
target_home="${target_home:-}"
target_user="${target_user:-}"
target_group="${target_group:-}"
colima_label="${colima_label:-}"
colima_start="${colima_start:-}"
tmp_dir="${tmp_dir:-}"

prepare_colima_service() {
  colima_binary="$(find_executable colima 2>/dev/null || true)"
  [ -n "$colima_binary" ] || fail "missing colima binary"
  [ -x "$colima_start" ] || fail "missing executable $colima_start"
}

check_colima() {
  local status_output

  check_job "$colima_label"
  if can_run_as_target; then
    status_output="$(run_as_target "$colima_binary" status 2>&1 || true)"
    printf '%s\n' "$status_output" | grep -qi "colima is running" \
      || fail "$colima_label is loaded but Colima is not running"
  else
    printf 'skipped %s functional check (requires root or %s)\n' "$colima_label" "$target_user"
  fi
}

install_colima_service() {
  local colima_plist="$tmp_dir/$colima_label.plist"

  run_as_target "$colima_start"
  install -d -o "$target_user" -g "$target_group" -m 0750 "$target_home/.local/log/colima"
  create_plist \
    "$colima_plist" \
    "$colima_label" \
    "$target_home" \
    "$target_home/.local/log/colima/launchd.log" \
    "$target_home/.local/log/colima/launchd-error.log" \
    "$colima_start"
  plutil -replace KeepAlive -bool false "$colima_plist"
  install_job "$colima_plist" "$colima_label"
  check_colima
}
