#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-sops-age-test.XXXXXX")"
trap 'rm -rf -- "$tmp_root"' EXIT
fixture_bin="$tmp_root/bin"
fixture_home="$tmp_root/home"
script="$repo_root/scripts/secrets/configure-sops-age-identity.sh"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

path_mode() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

mkdir -p "$fixture_bin" "$fixture_home"

cat > "$fixture_bin/age-keygen" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  -o)
    [ "$#" -eq 2 ] || exit 2
    if [ "${AGE_KEYGEN_FAIL:-0}" = 1 ]; then
      : > "$2"
      exit 1
    fi
    printf '%s%s\n' 'AGE-SECRET-' 'KEY-1FIXTURE' > "$2"
    ;;
  -y)
    [ "$#" -eq 2 ] || exit 2
    [ -s "$2" ] || exit 1
    printf 'age1fixtureidentity\n'
    ;;
  *)
    exit 2
    ;;
esac
EOF

cat > "$fixture_bin/sops" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  printf 'sops %s\n' "${SOPS_FIXTURE_VERSION:-3.13.3}"
  exit 0
fi

case "${1:-}" in
  encrypt)
    printf '%s\n' "$*" | grep -Fq -- '--age age1fixtureidentity' || exit 3
    ;;
  decrypt)
    [ -n "${SOPS_AGE_KEY_FILE:-}" ] || exit 3
    [ -f "$SOPS_AGE_KEY_FILE" ] || exit 3
    ;;
  *)
    exit 3
    ;;
esac

input=""
for arg in "$@"; do
  if [ -f "$arg" ]; then
    input="$arg"
  fi
done
[ -n "$input" ] || exit 2
cat "$input"
EOF

chmod 0700 "$fixture_bin/age-keygen" "$fixture_bin/sops"
fixture_path="$fixture_bin:$PATH"

output="$(HOME="$fixture_home" XDG_CONFIG_HOME="$fixture_home/.config" PATH="$fixture_path" "$script")"
identity_file="$fixture_home/.config/sops/age/keys.txt"
[ -f "$identity_file" ] || fail "provisioning did not create the default identity"
[ "$(path_mode "$(dirname "$identity_file")")" = 700 ] || fail "identity directory mode is not 0700"
[ "$(path_mode "$identity_file")" = 600 ] || fail "identity file mode is not 0600"
printf '%s\n' "$output" | grep -Fqx "SOPS age identity ready: $identity_file" \
  || fail "provisioning output missed the identity path"
printf '%s\n' "$output" | grep -Fqx 'public recipient: age1fixtureidentity' \
  || fail "provisioning output missed the public recipient"
printf '%s\n' "$output" | grep -Fqx \
  'backup required: save the private identity in the approved human recovery system before use' \
  || fail "provisioning output missed the recovery requirement"

before="$(cksum "$identity_file")"
HOME="$fixture_home" XDG_CONFIG_HOME="$fixture_home/.config" PATH="$fixture_path" "$script" >/dev/null
after="$(cksum "$identity_file")"
[ "$before" = "$after" ] || fail "idempotent provisioning replaced the existing identity"

HOME="$fixture_home" XDG_CONFIG_HOME="$fixture_home/.config" PATH="$fixture_path" \
  "$script" --check | grep -Fqx 'ok owner, permissions, recipient, and SOPS round trip' \
  || fail "identity check did not verify the complete contract"

recipient="$(HOME="$fixture_home" XDG_CONFIG_HOME="$fixture_home/.config" PATH="$fixture_path" \
  "$script" --print-recipient)"
[ "$recipient" = age1fixtureidentity ] || fail "print-recipient returned unexpected output"

explicit_file="$tmp_root/explicit/identity.txt"
HOME="$fixture_home" SOPS_AGE_KEY_FILE="$explicit_file" PATH="$fixture_path" "$script" >/dev/null
[ -f "$explicit_file" ] || fail "explicit SOPS_AGE_KEY_FILE was ignored"

failed_file="$tmp_root/failed/identity.txt"
if HOME="$fixture_home" SOPS_AGE_KEY_FILE="$failed_file" AGE_KEYGEN_FAIL=1 PATH="$fixture_path" \
  "$script" >/dev/null 2>&1; then
  fail "provisioning accepted a failed age-keygen run"
fi
[ ! -e "$failed_file" ] || fail "failed age-keygen left a partial identity"

if HOME="$fixture_home" XDG_CONFIG_HOME="$fixture_home/.config" \
  SOPS_FIXTURE_VERSION=3.8.1 PATH="$fixture_path" "$script" --check >/dev/null 2>&1; then
  fail "identity check accepted an unsupported SOPS version"
fi

chmod 0644 "$identity_file"
if HOME="$fixture_home" XDG_CONFIG_HOME="$fixture_home/.config" PATH="$fixture_path" \
  "$script" --check >/dev/null 2>&1; then
  fail "identity check accepted weak file permissions"
fi
chmod 0600 "$identity_file"

missing_home="$tmp_root/missing"
mkdir -p "$missing_home"
if HOME="$missing_home" XDG_CONFIG_HOME="$missing_home/.config" PATH="$fixture_path" \
  "$script" --check >/dev/null 2>&1; then
  fail "identity check created a missing identity"
fi

symlink_home="$tmp_root/symlink"
symlink_target="$tmp_root/symlink-target"
mkdir -p "$symlink_home/.config/sops" "$symlink_target"
ln -s "$symlink_target" "$symlink_home/.config/sops/age"
if HOME="$symlink_home" XDG_CONFIG_HOME="$symlink_home/.config" PATH="$fixture_path" \
  "$script" >/dev/null 2>&1; then
  fail "provisioning accepted a symlinked identity directory"
fi

if HOME="$fixture_home" XDG_CONFIG_HOME="$fixture_home/.config" PATH="$fixture_path" \
  "$script" --check --print-recipient >/dev/null 2>&1; then
  fail "script accepted conflicting modes"
fi

printf 'ok SOPS age identity provisioning, recovery output, path overrides, and rejection cases\n'
