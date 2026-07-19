#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

# shellcheck source=scripts/lib/infisical-sudo.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/infisical-sudo.sh"
# shellcheck source=scripts/lib/infisical.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/infisical.sh"

cat >"$tmp_dir/bin/infisical" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$FAKE_INFISICAL_ARGV"
if [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}" ] \
  && [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-}" ]; then
  printf 'credential env present\n' >"$FAKE_INFISICAL_ENV"
fi
printf 'fixture-token\n'
EOF

cat >"$tmp_dir/bin/age" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "--decrypt" ] && shift
[ "${1:-}" = "-i" ] && shift
[ "${1:-}" = "$FAKE_AGE_IDENTITY" ] || exit 1
ciphertext_file="${2:-}"
[ -f "$ciphertext_file" ] || exit 1
IFS= read -r ciphertext <"$ciphertext_file"
[ "$ciphertext" = "fixture-ciphertext" ] || exit 1
printf 'fixture-password\n'
EOF

cat >"$tmp_dir/bin/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "-k" ] && shift
[ "${1:-}" = "-A" ] && shift
[ "${1:-}" = "-E" ] && shift
[ "${1:-}" = "-p" ] && shift 2
[ "${1:-}" = "--" ] && shift
if [ -n "${FAKE_SUDO_CALLED:-}" ]; then
  : >"$FAKE_SUDO_CALLED"
fi
if [ "${FAKE_SUDO_NOPASSWD:-0}" != 1 ]; then
  if [ "${FAKE_SUDO_REJECT:-0}" = 1 ]; then
    for _ in 1 2 3; do
      password="$("$SUDO_ASKPASS")"
      [ "$password" = "fixture-password" ] || exit 1
    done
    exit 1
  else
    password="$("$SUDO_ASKPASS")"
    [ "$password" = "fixture-password" ] || exit 1
  fi
fi
exec "$@"
EOF
chmod 755 "$tmp_dir/bin/age" "$tmp_dir/bin/infisical" "$tmp_dir/bin/sudo"
: >"$tmp_dir/identity"
chmod 600 "$tmp_dir/identity"

token="$(
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_INFISICAL_ARGV="$tmp_dir/infisical-argv" \
    FAKE_INFISICAL_ENV="$tmp_dir/infisical-env" \
    infisical_mint_machine_token \
    https://example.invalid/api fixture-client fixture-secret
)"
[ "$token" = "fixture-token" ]
[ -e "$tmp_dir/infisical-env" ]
if grep -Eq 'fixture-(client|secret)|--client-(id|secret)' "$tmp_dir/infisical-argv"; then
  printf 'FAILED: Universal Auth credential leaked into Infisical argv\n' >&2
  exit 1
fi

# shellcheck disable=SC2016
output="$(
  printf 'caller-input\n' | \
    FAKE_AGE_IDENTITY="$tmp_dir/identity" \
    infisical_sudo_exec \
    "$tmp_dir/bin/sudo" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/infisical-sudo-askpass.sh" \
    "$tmp_dir/bin/age" \
    "$tmp_dir/identity" \
    fixture-ciphertext \
    sh -c 'IFS= read -r line; printf "sudo runner verified: %s\n" "$line"'
)"
[ "$output" = "sudo runner verified: caller-input" ] || {
  printf 'FAILED: unexpected sudo runner output\n' >&2
  exit 1
}

# NOPASSWD/cached behavior must not expose the unread credential to the command.
# shellcheck disable=SC2016
nopasswd_output="$(
  printf 'caller-input\n' | \
    FAKE_SUDO_NOPASSWD=1 \
    FAKE_AGE_IDENTITY="$tmp_dir/identity" \
    infisical_sudo_exec \
    "$tmp_dir/bin/sudo" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/infisical-sudo-askpass.sh" \
    "$tmp_dir/bin/age" \
    "$tmp_dir/identity" \
    fixture-ciphertext \
    sh -c 'IFS= read -r line; printf "nopasswd stdin: %s\n" "$line"'
)"
[ "$nopasswd_output" = "nopasswd stdin: caller-input" ] || {
  printf 'FAILED: NOPASSWD command received the credential stream\n' >&2
  exit 1
}

# Nested mode keeps the caller unprivileged while providing askpass to a sudo
# process started by the caller.
# shellcheck disable=SC2016
nested_output="$(
  printf 'caller-input\n' | \
    FAKE_AGE_IDENTITY="$tmp_dir/identity" \
    infisical_sudo_exec_nested \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/infisical-sudo-askpass.sh" \
    "$tmp_dir/bin/age" \
    "$tmp_dir/identity" \
    fixture-ciphertext \
    sh -c 'IFS= read -r line; "$1" -E -- printf "nested sudo: %s\n" "$line"' \
    _ "$tmp_dir/bin/sudo"
)"
[ "$nested_output" = "nested sudo: caller-input" ] || {
  printf 'FAILED: unexpected nested sudo runner output\n' >&2
  exit 1
}

mkdir -p "$tmp_dir/retry-tmp"
set +e
TMPDIR="$tmp_dir/retry-tmp" \
  FAKE_SUDO_REJECT=1 \
  FAKE_AGE_IDENTITY="$tmp_dir/identity" \
  infisical_sudo_exec \
  "$tmp_dir/bin/sudo" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/infisical-sudo-askpass.sh" \
  "$tmp_dir/bin/age" \
  "$tmp_dir/identity" \
  fixture-ciphertext \
  true
retry_status=$?
set -e
[ "$retry_status" -eq 1 ] || {
  printf 'FAILED: rejected sudo credential returned %s, expected 1\n' "$retry_status" >&2
  exit 1
}
[ -z "$(find "$tmp_dir/retry-tmp" -mindepth 1 -print -quit)" ] || {
  printf 'FAILED: rejected sudo credential left temporary state\n' >&2
  exit 1
}

set +e
TMPDIR="$tmp_dir/missing-tmp" \
  FAKE_SUDO_CALLED="$tmp_dir/setup-failure-called" \
  FAKE_AGE_IDENTITY="$tmp_dir/identity" \
  infisical_sudo_exec \
  "$tmp_dir/bin/sudo" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/infisical-sudo-askpass.sh" \
  "$tmp_dir/bin/age" \
  "$tmp_dir/identity" \
  fixture-ciphertext \
  true
setup_status=$?
set -e
[ "$setup_status" -ne 0 ] || {
  printf 'FAILED: invalid TMPDIR unexpectedly succeeded\n' >&2
  exit 1
}
[ ! -e "$tmp_dir/setup-failure-called" ] || {
  printf 'FAILED: sudo ran after credential setup failed\n' >&2
  exit 1
}

mkdir -p "$tmp_dir/signal-tmp"
set +e
bash -c '
  set -euo pipefail
  . "$1"
  export TMPDIR="$2"
  infisical_sudo_install_cleanup_traps
  INFISICAL_SUDO_TMP_DIR="$TMPDIR/uinaf-sudo.signal"
  mkdir -p "$INFISICAL_SUDO_TMP_DIR"
  printf "%s\n" fixture-ciphertext >"$INFISICAL_SUDO_TMP_DIR/password.age"
  kill -TERM "$$"
' _ "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/infisical-sudo.sh" "$tmp_dir/signal-tmp"
signal_status=$?
set -e
[ "$signal_status" -eq 143 ] || {
  printf 'FAILED: signal cleanup returned %s, expected 143\n' "$signal_status" >&2
  exit 1
}
[ -z "$(find "$tmp_dir/signal-tmp" -mindepth 1 -print -quit)" ] || {
  printf 'FAILED: signal cleanup left temporary state\n' >&2
  exit 1
}

set +e
FAKE_AGE_IDENTITY="$tmp_dir/identity" infisical_sudo_exec \
  "$tmp_dir/bin/sudo" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/infisical-sudo-askpass.sh" \
  "$tmp_dir/bin/age" \
  "$tmp_dir/identity" \
  fixture-ciphertext \
  sh -c 'exit 42'
status=$?
set -e
[ "$status" -eq 42 ] || {
  printf 'FAILED: sudo runner returned %s, expected 42\n' "$status" >&2
  exit 1
}

printf 'ok Infisical sudo runner isolates the credential stream from the command\n'
