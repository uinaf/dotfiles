#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runner="$repo_root/scripts/secrets/sops-devbox-sudo.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

home="$tmp_dir/home"
config="$tmp_dir/devbox.env"
payload="$tmp_dir/sudo.sops.json"
sops_identity="$tmp_dir/sops-keys.txt"
sudo_identity="$tmp_dir/sudo-keys.txt"
fake_sops="$tmp_dir/sops"
log="$tmp_dir/sops.log"
mkdir -p "$home"
printf '{}\n' >"$payload"
printf '# sops fixture\n' >"$sops_identity"
printf '# sudo fixture\n' >"$sudo_identity"
printf 'SOPS_SUDO_SECRET_FILE=%s\n' "$payload" >"$config"
printf 'SUDO_AGE_IDENTITY_FILE=%s\n' "$sudo_identity" >>"$config"
chmod 0600 "$config" "$sops_identity" "$sudo_identity"

cat >"$fake_sops" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$SUDO_AGE_IDENTITY_FILE" = "$EXPECTED_SUDO_IDENTITY" ] || exit 71
[ "$SOPS_AGE_KEY_FILE" = "$EXPECTED_SOPS_IDENTITY" ] || exit 72
case "${4:-}" in
  *--consume-secret*/*bin/true*) ;;
  *) exit 73 ;;
esac
printf '<%s>' "$@" >"$FAKE_SOPS_LOG"
EOF
chmod 0700 "$fake_sops"

HOME="$home" \
DEVBOX_CONFIG="$config" \
SOPS_BINARY="$fake_sops" \
SOPS_AGE_KEY_FILE="$sops_identity" \
EXPECTED_SUDO_IDENTITY="$sudo_identity" \
EXPECTED_SOPS_IDENTITY="$sops_identity" \
FAKE_SOPS_LOG="$log" \
  "$runner" -- /usr/bin/true

grep -Fq "<exec-env><--same-process><$payload>" "$log" \
  || fail "runner did not select the configured SOPS payload"

printf 'ok SOPS sudo runner preserves both age identity boundaries\n'
