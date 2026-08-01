#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

HOME="$tmp_root/home"
mkdir -p "$HOME/.ssh/nested"
export json_output=1
export warn_count=0
export fail_count=0
export secret_scan_count=0

# shellcheck source=scripts/lib/audit.sh
. "$repo_root/scripts/lib/audit.sh"

printf 'ssh-ed25519 fixture authorized\n' > "$HOME/.ssh/authorized_keys"
chmod 0644 "$HOME/.ssh/authorized_keys"
printf '\n-----BEGIN OPENSSH PRIVATE KEY-----\n' > "$HOME/.ssh/nested/id_ed25519"
chmod 0644 "$HOME/.ssh/nested/id_ed25519"
check_ssh_private_key_modes
[ "$fail_count" -eq 1 ] || fail "nested private key mode was not rejected exactly once"

fail_count=0
printf '%s\n' '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----' > "$HOME/.ssh/nested/id_ssh2"
printf '%s\n' 'PuTTY-User-Key-File-3: ssh-ed25519' > "$HOME/.ssh/nested/id_putty"
chmod 0600 "$HOME/.ssh/nested/id_ed25519" "$HOME/.ssh/nested/id_ssh2" "$HOME/.ssh/nested/id_putty"
check_ssh_private_key_modes
[ "$fail_count" -eq 0 ] || fail "owner-only private keys or authorized_keys were misclassified"

workstation_json="$(DOTFILES_AUDIT_NAME=workstation-security HOME="$HOME" SHELL=/bin/sh "$repo_root/scripts/audit/workstation.sh" --json 2>/dev/null || true)"
printf '%s\n' "$workstation_json" | grep -Fq '"audit":"workstation-security"' \
  || fail "workstation JSON audit name changed"
if printf '%s\n' "$workstation_json" | grep -Fq '"user":'; then
  fail "workstation JSON exposed the Unix user"
fi

personal_json="$(HOME="$HOME" SHELL=/bin/sh "$repo_root/scripts/audit/personal.sh" --json 2>/dev/null || true)"
printf '%s\n' "$personal_json" | grep -Fq '"audit":"personal-security"' \
  || fail "personal compatibility audit name changed"

personal_task_json="$(cd "$repo_root" && HOME="$HOME" SHELL=/bin/sh ./.mise/tasks/audit/personal/json 2>/dev/null || true)"
printf '%s\n' "$personal_task_json" | grep -Fq '"audit":"personal-security"' \
  || fail "personal compatibility task bypassed the personal audit wrapper"

grep -Fqx './scripts/audit/personal.sh' "$repo_root/.mise/tasks/audit/personal/_default" \
  || fail "personal default task bypassed the personal audit wrapper"

mkdir -p "$HOME/.config/uinaf"
ln -s "$HOME/missing-audit-policy" "$HOME/.config/uinaf/audit.env"
fail_count=0
AUDIT_POLICY_FILE='' load_audit_policy
[ "$fail_count" -eq 1 ] || fail "unsafe legacy audit policy did not record a failed check"
rm "$HOME/.config/uinaf/audit.env"
fail_count=0
printf 'DEVBOX_USER=legacy-fixture\nPROCESS_COMPOSE_ENABLED=0\n' > "$HOME/.config/uinaf/devbox.env"
devbox_json="$(HOME="$HOME" USER=fixture SHELL=/bin/sh "$repo_root/scripts/audit/devbox.sh" --json 2>/dev/null || true)"
printf '%s\n' "$devbox_json" | grep -Fq '"devbox_user":"legacy-fixture"' \
  || fail "devbox audit ignored the supported legacy config"

printf 'ok audit output privacy and recursive SSH private-key classification\n'
