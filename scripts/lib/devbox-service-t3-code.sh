#!/usr/bin/env bash

# Populated by install-devbox-service-daemons.sh before these helpers run.
t3_label="${t3_label:-}"
t3_version="${t3_version:-}"
t3_working_directory="${t3_working_directory:-}"
t3_service_dir="${t3_service_dir:-}"
t3_entrypoint="${t3_entrypoint:-}"
t3_node_binary="${t3_node_binary:-}"
t3_npm_binary="${t3_npm_binary:-}"
t3_plist="${t3_plist:-}"
target_group="${target_group:-}"
target_home="${target_home:-}"
target_user="${target_user:-}"
tmp_dir="${tmp_dir:-}"
launch_daemon_dir="${launch_daemon_dir:-}"

dotfiles_validate_t3_version() {
  local version="$1"
  case "$version" in
    ""|*[!A-Za-z0-9._+-]*) return 1 ;;
  esac
}

resolve_t3_code_service() {
  local node_command npm_command resolved_node

  dotfiles_validate_t3_version "$t3_version" \
    || fail "T3 Code version must be one exact npm version"
  case "$t3_working_directory" in
    /*) ;;
    *) fail "T3 Code working directory must be an absolute path" ;;
  esac
  [ -d "$t3_working_directory" ] \
    || fail "missing T3 Code working directory: $t3_working_directory"

  node_command="$(find_executable node)" || fail "missing Node for $target_user"
  npm_command="$(find_executable npm)" || fail "missing npm for $target_user"
  resolved_node="$(run_as_target "$node_command" -p 'process.execPath')" \
    || fail "could not resolve Node for $target_user"
  case "$resolved_node" in
    /*) ;;
    *) fail "Node resolved to a non-absolute path for $target_user" ;;
  esac
  [ -x "$resolved_node" ] || fail "resolved Node is not executable: $resolved_node"

  t3_node_binary="$resolved_node"
  t3_npm_binary="$npm_command"
  t3_service_dir="$target_home/.local/share/t3-code/service/$t3_version"
  t3_entrypoint="$t3_service_dir/node_modules/t3/dist/bin.mjs"
}

prepare_t3_code_service() {
  local stored_version

  run_as_target install -d -m 0755 "$t3_service_dir"
  stored_version="$(
    run_as_target "$t3_node_binary" -e \
      'try { process.stdout.write(require(process.argv[1]).dependencies?.t3 ?? "") } catch {}' \
      "$t3_service_dir/package.json"
  )"
  if [ "$stored_version" != "$t3_version" ] || [ ! -f "$t3_entrypoint" ]; then
    run_as_target "$t3_npm_binary" install \
      --prefix "$t3_service_dir" \
      --save-exact \
      --no-audit \
      --no-fund \
      "t3@$t3_version"
  fi
  [ -f "$t3_entrypoint" ] || fail "T3 Code package has no server entrypoint"

  t3_plist="$tmp_dir/$t3_label.plist"
  create_plist \
    "$t3_plist" \
    "$t3_label" \
    "$t3_working_directory" \
    "$target_home/Library/Logs/t3-code/server.log" \
    "$target_home/Library/Logs/t3-code/server-error.log" \
    "$t3_node_binary" \
    "$t3_entrypoint" \
    serve \
    --base-dir \
    "$target_home/.t3"
  plutil -insert ProcessType -string Background "$t3_plist"
  plutil -insert EnvironmentVariables -xml '<dict></dict>' "$t3_plist"
  plutil -insert EnvironmentVariables.HOME -string "$target_home" "$t3_plist"
  plutil -insert EnvironmentVariables.LOGNAME -string "$target_user" "$t3_plist"
  plutil -insert EnvironmentVariables.PATH -string \
    "$target_home/.local/bin:$target_home/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$t3_plist"
  plutil -insert EnvironmentVariables.SHELL -string /bin/zsh "$t3_plist"
  plutil -insert EnvironmentVariables.USER -string "$target_user" "$t3_plist"
  plutil -lint "$t3_plist" >/dev/null

  run_as_target install -d -m 0755 "$target_home/Library/Logs/t3-code"
  install -o "$target_user" -g "$target_group" -m 0644 \
    "$t3_plist" "$t3_service_dir/$t3_label.plist"
}

check_t3_code_health() {
  local attempt
  attempt=1
  while [ "$attempt" -le 30 ]; do
    if curl --fail --silent --show-error --max-time 2 \
      http://127.0.0.1:3773/ >/dev/null 2>&1; then
      printf 'ok %s HTTP health for %s\n' "$t3_label" "$target_user"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  fail "$t3_label did not become healthy on http://127.0.0.1:3773/"
}

check_t3_code() {
  local installed_entrypoint

  check_job "$t3_label"
  installed_entrypoint="$(
    plutil -extract ProgramArguments.1 raw "$launch_daemon_dir/$t3_label.plist" 2>/dev/null
  )" || fail "$t3_label plist has no T3 Code entrypoint"
  [ "$installed_entrypoint" = "$t3_entrypoint" ] \
    || fail "$t3_label does not use T3 Code $t3_version"
  [ -f "$t3_entrypoint" ] || fail "missing T3 Code entrypoint: $t3_entrypoint"
  check_t3_code_health
}

install_t3_code_service() {
  install_job "$t3_plist" "$t3_label"
  check_t3_code_health
}
