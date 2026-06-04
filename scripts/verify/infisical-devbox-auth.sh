#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/uinaf-infisical-devbox-auth.XXXXXX")"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

write_fake_infisical() {
  local fake_bin="$tmp_dir/bin"
  mkdir -p "$fake_bin"

  cat > "$fake_bin/infisical" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  printf 'fake-infisical 0.0.0\n'
  exit 0
fi

if [ "${1:-}" = "login" ] && [ "${2:-}" = "status" ]; then
  case "${INFISICAL_FAKE_STATUS:-machine-unauthenticated}" in
    machine-unauthenticated)
      printf '{"sessions":[{"principalType":"machine-identity","status":"unauthenticated"}]}\n'
      exit 1
      ;;
    user-authenticated)
      printf '{"sessions":[{"principalType":"user","status":"authenticated"}]}\n'
      exit 0
      ;;
    user-expired)
      printf '{"sessions":[{"principalType":"user","status":"expired"}]}\n'
      exit 1
      ;;
    unknown-nonzero)
      printf '{"sessions":[{"principalType":"user","status":"unknown"}]}\n'
      exit 1
      ;;
    *)
      printf 'unknown INFISICAL_FAKE_STATUS=%s\n' "$INFISICAL_FAKE_STATUS" >&2
      exit 98
      ;;
  esac
fi

if [ "${1:-}" = "login" ]; then
  client_id=""
  client_secret=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --client-id)
        client_id="$2"
        shift 2
        ;;
      --client-secret)
        client_secret="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  [ -n "$client_id" ] || exit 22
  [ -n "$client_secret" ] || exit 23
  if [ -n "${INFISICAL_FAKE_LOG:-}" ]; then
    printf 'login client-id=%s client-secret=%s\n' "$client_id" "$client_secret" >> "$INFISICAL_FAKE_LOG"
  fi
  printf 'fake-token\n'
  exit 0
fi

if [ "${1:-}" = "export" ]; then
  token=""
  project_id=""
  env_name=""
  secret_path=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --token)
        token="$2"
        shift 2
        ;;
      --projectId)
        project_id="$2"
        shift 2
        ;;
      --env)
        env_name="$2"
        shift 2
        ;;
      --path)
        secret_path="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  if [ -n "${INFISICAL_FAKE_LOG:-}" ]; then
    printf 'export token=%s projectId=%s env=%s path=%s\n' "$token" "$project_id" "$env_name" "$secret_path" >> "$INFISICAL_FAKE_LOG"
  fi
  [ "$token" = "fake-token" ] || exit 31
  [ -n "$project_id" ] || exit 32
  [ -n "$env_name" ] || exit 33
  [ -n "$secret_path" ] || exit 34
  exit 0
fi

if [ "${1:-}" = "secrets" ] && [ "${2:-}" = "get" ]; then
  printf 'ZmFrZQo=\n'
  exit 0
fi

printf 'unexpected fake infisical invocation: %s\n' "$*" >&2
exit 99
FAKE
  chmod +x "$fake_bin/infisical"
  printf '%s' "$fake_bin"
}

write_file_600() {
  local path="$1"
  shift

  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$@" > "$path"
  chmod 600 "$path"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"

  printf '%s\n' "$haystack" | grep -Fq "$needle" \
    || fail "expected output to contain: $needle"
}

fake_bin="$(write_fake_infisical)"
fake_log="$tmp_dir/fake-infisical.log"

custom_config="$tmp_dir/custom-devbox.env"
machine_config="$tmp_dir/infisical-machine.env"
write_file_600 "$custom_config" \
  "INFISICAL_DOMAIN=https://eu.infisical.com/api" \
  "INFISICAL_PROJECT_ID=custom-project" \
  "INFISICAL_ENV=dev" \
  "INFISICAL_SECRET_PATH=/custom/path" \
  "PROCESS_COMPOSE_ENABLED=0"
write_file_600 "$machine_config" \
  "INFISICAL_CLIENT_ID=file-client" \
  "INFISICAL_CLIENT_SECRET=file-secret"

# shellcheck disable=SC2016
runner_output="$(
  HOME="$tmp_dir/home" \
  PATH="$fake_bin:$PATH" \
  UINAF_DEVBOX_CONFIG="$custom_config" \
  INFISICAL_MACHINE_CONFIG="$machine_config" \
    "$repo_root/scripts/secrets/infisical-devbox-run.sh" -- sh -c 'printf "%s|%s|%s\n" "$INFISICAL_PROJECT_ID" "$INFISICAL_SECRET_PATH" "${INFISICAL_CLIENT_ID-unset}"'
)"
[ "$runner_output" = "custom-project|/custom/path|unset" ] \
  || fail "runner did not honor UINAF_DEVBOX_CONFIG and strip client credentials: $runner_output"
printf 'ok runner honors UINAF_DEVBOX_CONFIG and strips client credentials\n'

missing_secret_config="$tmp_dir/missing-secret-machine.env"
write_file_600 "$missing_secret_config" "INFISICAL_CLIENT_ID=file-client"
set +e
ambient_output="$(
  HOME="$tmp_dir/home" \
  PATH="$fake_bin:$PATH" \
  UINAF_DEVBOX_CONFIG="$custom_config" \
  INFISICAL_MACHINE_CONFIG="$missing_secret_config" \
  INFISICAL_CLIENT_SECRET=ambient-secret \
    "$repo_root/scripts/secrets/infisical-devbox-run.sh" -- /bin/true 2>&1
)"
ambient_status=$?
set -e
[ "$ambient_status" -ne 0 ] || fail "runner accepted ambient client secret"
assert_contains "$ambient_output" "INFISICAL_CLIENT_SECRET is required"
printf 'ok runner requires client secret from machine config\n'

set +e
human_session_output="$(
  HOME="$tmp_dir/home" \
  PATH="$fake_bin:$PATH" \
  UINAF_DEVBOX_CONFIG="$custom_config" \
  INFISICAL_MACHINE_CONFIG="$machine_config" \
  INFISICAL_FAKE_STATUS=user-authenticated \
    "$repo_root/scripts/secrets/infisical-devbox-run.sh" -- /bin/true 2>&1
)"
human_session_status=$?
set -e
[ "$human_session_status" -ne 0 ] || fail "runner accepted authenticated human Infisical session"
assert_contains "$human_session_output" "Infisical CLI has an authenticated human user session"
printf 'ok runner rejects authenticated human Infisical session\n'

set +e
unknown_status_output="$(
  HOME="$tmp_dir/home" \
  PATH="$fake_bin:$PATH" \
  UINAF_DEVBOX_CONFIG="$custom_config" \
  INFISICAL_MACHINE_CONFIG="$machine_config" \
  INFISICAL_FAKE_STATUS=unknown-nonzero \
    "$repo_root/scripts/secrets/infisical-devbox-run.sh" -- /bin/true 2>&1
)"
unknown_status_code=$?
set -e
[ "$unknown_status_code" -ne 0 ] || fail "runner accepted unknown nonzero Infisical session state"
assert_contains "$unknown_status_output" "could not verify Infisical login status session state"
printf 'ok runner rejects unknown nonzero Infisical session state\n'

set +e
required_output="$(
  HOME="$tmp_dir/empty-home" \
  PATH="$fake_bin:$PATH" \
  PROCESS_COMPOSE_ENABLED=0 \
    "$repo_root/scripts/verify/devbox-services.sh" 2>&1
)"
required_status=$?
set -e
[ "$required_status" -ne 0 ] || fail "devbox verifier accepted missing persistent config by default"
assert_contains "$required_output" "missing $tmp_dir/empty-home/.config/uinaf/devbox.env"
printf 'ok devbox verifier requires persistent config by default\n'

optional_output="$(
  HOME="$tmp_dir/empty-home" \
  PATH="$fake_bin:$PATH" \
  PROCESS_COMPOSE_ENABLED=0 \
  INFISICAL_MACHINE_AUTH_REQUIRED=0 \
    "$repo_root/scripts/verify/devbox-services.sh"
)"
assert_contains "$optional_output" "devbox verification ok"
printf 'ok devbox verifier can run optional repo smoke mode\n'

: > "$fake_log"
required_happy_output="$(
  HOME="$tmp_dir/home" \
  PATH="$fake_bin:$PATH" \
  UINAF_DEVBOX_CONFIG="$custom_config" \
  INFISICAL_MACHINE_CONFIG="$machine_config" \
  INFISICAL_FAKE_LOG="$fake_log" \
    "$repo_root/scripts/verify/devbox-services.sh"
)"
assert_contains "$required_happy_output" "Infisical machine identity can read /custom/path"
fake_log_output="$(cat "$fake_log")"
assert_contains "$fake_log_output" "login client-id=file-client client-secret=file-secret"
assert_contains "$fake_log_output" "export token=fake-token projectId=custom-project env=dev path=/custom/path"
printf 'ok devbox verifier proves machine token export wiring in required mode\n'

set +e
verify_ambient_output="$(
  HOME="$tmp_dir/home" \
  PATH="$fake_bin:$PATH" \
  UINAF_DEVBOX_CONFIG="$custom_config" \
  INFISICAL_MACHINE_CONFIG="$missing_secret_config" \
  INFISICAL_CLIENT_SECRET=ambient-secret \
    "$repo_root/scripts/verify/devbox-services.sh" 2>&1
)"
verify_ambient_status=$?
set -e
[ "$verify_ambient_status" -ne 0 ] || fail "devbox verifier accepted ambient client secret"
assert_contains "$verify_ambient_output" "Infisical auth material is exported by the default login shell"
printf 'ok devbox verifier rejects ambient Infisical auth material\n'

printf '\ninfisical devbox auth verification ok\n'
