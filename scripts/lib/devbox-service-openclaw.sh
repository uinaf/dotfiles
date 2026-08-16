#!/usr/bin/env bash

# Populated by install-devbox-service-daemons.sh before these helpers run.
target_home="${target_home:-}"
target_uid="${target_uid:-}"
target_user="${target_user:-}"
target_group="${target_group:-}"
openclaw_label="${openclaw_label:-}"
openclaw_port="${openclaw_port:-}"
openclaw_restart_sudoers="${openclaw_restart_sudoers:-}"
openclaw_wrapper="${openclaw_wrapper:-}"
sudoers_dir="${sudoers_dir:-}"
tmp_dir="${tmp_dir:-}"

validate_openclaw_wrapper() {
  local wrapper="$1"
  local wrapper_parent
  local trusted_path
  local current_dir
  local path_mode

  [ -f "$wrapper" ] || fail "OpenClaw wrapper must be a regular file: $wrapper"
  [ ! -L "$wrapper" ] || fail "OpenClaw wrapper must not be a symlink: $wrapper"
  wrapper_parent="$(cd -P -- "$(dirname "$wrapper")" && pwd)"
  trusted_path="$wrapper_parent/$(basename "$wrapper")"
  case "$trusted_path" in
    "$target_home"/*) ;;
    *) fail "OpenClaw wrapper must resolve inside $target_home" ;;
  esac
  [ -x "$trusted_path" ] || fail "missing executable $trusted_path"
  [ "$(stat -f '%Su' "$trusted_path")" = "$target_user" ] \
    || fail "OpenClaw wrapper must be owned by $target_user"
  path_mode="$(stat -f '%Lp' "$trusted_path")"
  [ $((8#$path_mode & 0022)) -eq 0 ] \
    || fail "OpenClaw wrapper must not be group/world-writable: $trusted_path"

  current_dir="$wrapper_parent"
  while :; do
    path_mode="$(stat -f '%Lp' "$current_dir")"
    [ $((8#$path_mode & 0022)) -eq 0 ] \
      || fail "OpenClaw wrapper parent must not be group/world-writable: $current_dir"
    [ "$current_dir" != "$target_home" ] || break
    current_dir="$(dirname "$current_dir")"
  done

  openclaw_wrapper="$trusted_path"
}

check_openclaw_restart_sudoers() {
  local expected_rule
  local allowed_command
  local authorization_output

  expected_rule="$(dotfiles_openclaw_restart_sudoers_rule "$target_user" "$openclaw_label")"
  allowed_command="${expected_rule#*NOPASSWD: }"
  if [ "$(id -u)" -ne 0 ]; then
    [ "$(id -u)" -eq "$target_uid" ] \
      || fail "OpenClaw restart policy check requires root or $target_user"
    authorization_output="$(
      /usr/bin/sudo -n -l \
        /bin/launchctl kickstart -k "system/$openclaw_label"
    )" || fail "$target_user cannot restart only $openclaw_label without a password"
    printf '%s\n' "$authorization_output" | grep -Fqx -- "$allowed_command" \
      || fail "$target_user sudo authorization does not match the exact OpenClaw restart command"
    printf 'ok %s may restart only %s\n' "$target_user" "$openclaw_label"
    return
  fi

  [ -f "$openclaw_restart_sudoers" ] && [ ! -L "$openclaw_restart_sudoers" ] \
    || fail "missing regular sudoers policy $openclaw_restart_sudoers"
  [ "$(stat -f '%Su:%Sg:%Lp' "$openclaw_restart_sudoers")" = "root:wheel:440" ] \
    || fail "$openclaw_restart_sudoers must be root:wheel mode 0440"
  if [ "$(wc -l < "$openclaw_restart_sudoers" | tr -d ' ')" != 1 ] \
    || ! grep -Fqx -- "$expected_rule" "$openclaw_restart_sudoers"; then
    fail "$openclaw_restart_sudoers does not match the exact OpenClaw restart policy"
  fi
  /usr/sbin/visudo -cf "$openclaw_restart_sudoers" >/dev/null \
    || fail "invalid sudoers policy $openclaw_restart_sudoers"
  printf 'ok %s may restart only %s\n' "$target_user" "$openclaw_label"
}

prepare_openclaw_service() {
  openclaw_env_wrapper="$target_home/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh"
  openclaw_env_file="$target_home/.openclaw/service-env/ai.openclaw.gateway.env"
  openclaw_gateway_wrapper="$target_home/.local/bin/openclaw-gateway-mise-wrapper"
  openclaw_binary=""

  if [ -n "$openclaw_wrapper" ]; then
    validate_openclaw_wrapper "$openclaw_wrapper"
    openclaw_binary="$(find_executable openclaw 2>/dev/null || true)"
    [ -n "$openclaw_binary" ] || fail "missing OpenClaw executable"
  else
    [ -x "$openclaw_env_wrapper" ] || fail "missing executable $openclaw_env_wrapper"
    [ -f "$openclaw_env_file" ] || fail "missing $openclaw_env_file"
    [ -x "$openclaw_gateway_wrapper" ] || fail "missing executable $openclaw_gateway_wrapper"
  fi
}

install_openclaw_service() {
  local openclaw_plist="$tmp_dir/$openclaw_label.plist"

  install -d -o "$target_user" -g "$target_group" -m 0750 "$target_home/Library/Logs/openclaw"
  if [ -n "$openclaw_wrapper" ]; then
    create_plist \
      "$openclaw_plist" \
      "$openclaw_label" \
      "$target_home/.openclaw" \
      "$target_home/Library/Logs/openclaw/gateway.log" \
      "$target_home/Library/Logs/openclaw/gateway-error.log" \
      "$openclaw_wrapper" \
      "$openclaw_binary" \
      gateway \
      --port \
      "$openclaw_port"
  else
    create_plist \
      "$openclaw_plist" \
      "$openclaw_label" \
      "$target_home/.openclaw" \
      "$target_home/Library/Logs/openclaw/gateway.log" \
      "$target_home/Library/Logs/openclaw/gateway-error.log" \
      /bin/sh \
      "$openclaw_env_wrapper" \
      "$openclaw_env_file" \
      "$openclaw_gateway_wrapper" \
      gateway \
      --port \
      "$openclaw_port"
  fi
  install_job "$openclaw_plist" "$openclaw_label"
}

install_openclaw_restart_policy() {
  local policy_source="$tmp_dir/openclaw-restart-sudoers"

  [ -d "$sudoers_dir" ] || fail "missing $sudoers_dir"
  dotfiles_openclaw_restart_sudoers_rule "$target_user" "$openclaw_label" > "$policy_source"
  chmod 0440 "$policy_source"
  /usr/sbin/visudo -cf "$policy_source" >/dev/null \
    || fail "generated OpenClaw restart policy is invalid"
  install -o root -g wheel -m 0440 "$policy_source" "$openclaw_restart_sudoers"
  /usr/sbin/visudo -cf /etc/sudoers >/dev/null \
    || fail "installed sudoers policy does not validate with /etc/sudoers"
  check_openclaw_restart_sudoers
}
