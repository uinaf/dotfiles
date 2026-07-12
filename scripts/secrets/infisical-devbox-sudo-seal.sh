#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config_path="${DEVBOX_CONFIG:-$HOME/.config/uinaf/devbox.env}"
identity_file="${INFISICAL_SUDO_AGE_IDENTITY_FILE:-$HOME/.config/uinaf/sudo-age-identity.txt}"

# shellcheck source=scripts/lib/infisical.sh
. "$repo_root/scripts/lib/infisical.sh"
# shellcheck source=scripts/lib/infisical-sudo.sh
. "$repo_root/scripts/lib/infisical-sudo.sh"

usage() {
  cat <<'USAGE'
Usage:
  <concealed-password-command> | scripts/secrets/infisical-devbox-sudo-seal.sh

Reads one password line from stdin, encrypts it to this host's local age
identity, writes only SUDO_PASSWORD_AGE to the configured Infisical sudo path,
and verifies the round trip. Never pass the password as a command argument.
USAGE
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi
[ "$#" -eq 0 ] || {
  usage >&2
  exit 2
}

[ -e "$config_path" ] || fail "missing $config_path"
config_mode="$(infisical_file_mode "$config_path")"
[ "$config_mode" = "600" ] || fail "$config_path mode is $config_mode, expected 600"
# shellcheck disable=SC1090
. "$config_path"
[ -n "${INFISICAL_SUDO_SECRET_PATH:-}" ] \
  || fail "INFISICAL_SUDO_SECRET_PATH is required in $config_path"
[ -e "$identity_file" ] || fail "missing $identity_file"
identity_mode="$(infisical_file_mode "$identity_file")"
[ "$identity_mode" = "600" ] || fail "$identity_file mode is $identity_mode, expected 600"

age_bin="$(infisical_sudo_find_age)" || fail "missing age"
age_keygen_bin="${age_bin%/age}/age-keygen"
[ -x "$age_keygen_bin" ] || fail "missing trusted age-keygen beside age"

sudo_password=""
IFS= read -r sudo_password || [ -n "$sudo_password" ] \
  || fail "could not read password from stdin"
[ -n "$sudo_password" ] || fail "password from stdin is empty"
recipient="$($age_keygen_bin -y "$identity_file")"
ciphertext="$(printf '%s\n' "$sudo_password" | "$age_bin" --armor --recipient "$recipient")"
[ -n "$ciphertext" ] || fail "age returned empty ciphertext"

pipe_dir="$(mktemp -d)"
fifo="$pipe_dir/secrets.yaml"
writer_pid=""
cleanup() {
  if [ -n "$writer_pid" ]; then
    kill "$writer_pid" 2>/dev/null || true
    wait "$writer_pid" 2>/dev/null || true
  fi
  rm -rf "$pipe_dir"
  unset sudo_password ciphertext stored_ciphertext decrypted
}
trap cleanup EXIT
mkfifo "$fifo"
chmod 600 "$fifo"
{
  printf '%s\n' 'SUDO_PASSWORD_AGE: |-'
  printf '%s\n' "$ciphertext" | sed 's/^/  /'
} >"$fifo" &
writer_pid=$!

"$repo_root/scripts/secrets/infisical-devbox-run.sh" -- \
  infisical secrets set \
  --file "$fifo" \
  --path "$INFISICAL_SUDO_SECRET_PATH" \
  --output json \
  --silent >/dev/null
wait "$writer_pid"
writer_pid=""

stored_ciphertext="$(
  "$repo_root/scripts/secrets/infisical-devbox-run.sh" -- \
    infisical secrets get SUDO_PASSWORD_AGE \
    --path "$INFISICAL_SUDO_SECRET_PATH" \
    --plain \
    --silent
)"
decrypted="$(infisical_sudo_decrypt_age "$age_bin" "$identity_file" "$stored_ciphertext")"
[ "$decrypted" = "$sudo_password" ] || fail "encrypted sudo credential failed round-trip verification"

legacy_plaintext="$(
  "$repo_root/scripts/secrets/infisical-devbox-run.sh" -- \
    infisical secrets get SUDO_PASSWORD \
    --path "$INFISICAL_SUDO_SECRET_PATH" \
    --plain \
    --silent
)"
[ -z "$legacy_plaintext" ] || fail "legacy plaintext SUDO_PASSWORD still exists"
unset legacy_plaintext

printf 'encrypted sudo credential updated and verified\n'
