#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
configure_git="$repo_root/scripts/bootstrap/configure-git.sh"
ssh_entrypoint="$repo_root/chezmoi/private_dot_ssh/private_config"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

make_home() {
  local home="$1"

  mkdir -p "$home/.ssh"
  chmod 0700 "$home/.ssh"
  HOME="$home" git config --global gpg.format ssh
  HOME="$home" git config --global include.path "$home/.gitconfig.local"
  sed "s|~/.ssh|$home/.ssh|g" "$ssh_entrypoint" > "$home/.ssh/config"
}

make_key() {
  local path="$1"

  ssh-keygen -q -t ed25519 -N '' -f "$path"
}

make_encrypted_key() {
  local path="$1"

  ssh-keygen -q -t ed25519 -N 'fixture-passphrase' -f "$path"
}

configure() {
  local home="$1"
  local profile="$2"
  local signing_key="$3"
  local identity_file="${4:-}"
  local op_ssh_vault="${5:-}"

  HOME="$home" \
  GIT_USER_NAME='Example User' \
  GIT_USER_EMAIL='example@example.com' \
  GIT_SIGNING_KEY="$signing_key" \
  GIT_SSH_IDENTITY_FILE="$identity_file" \
  GIT_SIGN_COMMITS=true \
  OP_SSH_VAULT="$op_ssh_vault" \
    "$configure_git" --profile "$profile" --non-interactive
}

snapshot_owned() {
  local home="$1"
  local path

  for path in \
    "$home/.gitconfig.local" \
    "$home/.config/git/allowed_signers.local" \
    "$home/.local/libexec/uinaf/git-ssh-sign-agentless" \
    "$home/.ssh/github.config" \
    "$home/.ssh/config.local"; do
    if [ -f "$path" ]; then
      printf 'file %s ' "${path#"$home"}"
      shasum -a 256 "$path" | awk '{ print $1 }'
    else
      printf 'absent %s\n' "${path#"$home"}"
    fi
  done
}

assert_rejected_without_mutation() {
  local home="$1"
  local expected_error="$2"
  shift 2
  local before
  local after
  local output

  before="$(snapshot_owned "$home")"
  if output="$(configure "$@" 2>&1)"; then
    fail "invalid configuration was accepted"
  fi
  printf '%s\n' "$output" | grep -q "$expected_error" || fail "rejection did not explain: $expected_error"
  after="$(snapshot_owned "$home")"
  [ "$before" = "$after" ] || fail "owned files changed after rejected configuration"
}

[ "$(sed -n '1p' "$ssh_entrypoint")" = 'Include ~/.ssh/github.config' ] || fail "GitHub config is not the first SSH include"
grep -A1 '^Host \*$' "$ssh_entrypoint" | grep -q 'Include ~/.ssh/config.local' || fail "local SSH config is not included under an explicit Host * scope"

personal_home="$tmp_root/personal"
make_home "$personal_home"
make_key "$personal_home/.ssh/signing"
cat > "$personal_home/.ssh/extra.config" <<'EOF'
ServerAliveInterval 42
EOF
cat > "$personal_home/.ssh/config.local" <<EOF
Include $personal_home/.ssh/extra.config
StrictHostKeyChecking yes

Host unrelated.example
  User example

Host *
  IdentityAgent /tmp/preexisting-agent.sock
  IdentityFile /tmp/preexisting-identity
EOF
cp "$personal_home/.ssh/config.local" "$tmp_root/personal.config.before"

configure \
  "$personal_home" \
  personal \
  "$personal_home/.ssh/signing.pub" \
  "$personal_home/.ssh/signing" >/dev/null

[ "$(HOME="$personal_home" git config --file "$personal_home/.gitconfig.local" --get user.signingkey)" = "$personal_home/.ssh/signing" ] \
  || fail "personal Git signing did not select the matching local private key"
agentless_program="$personal_home/.local/libexec/uinaf/git-ssh-sign-agentless"
[ "$(HOME="$personal_home" git config --file "$personal_home/.gitconfig.local" --get gpg.ssh.program)" = "$agentless_program" ] \
  || fail "personal Git signing did not select the agentless signing program"
[ -x "$agentless_program" ] || fail "agentless signing program is not executable"
grep -qx 'unset SSH_AUTH_SOCK' "$agentless_program" || fail "agentless signing program does not clear SSH_AUTH_SOCK"

github_config="$personal_home/.ssh/github.config"
[ "$(grep -c '^# uinaf-dotfiles: github-ssh begin$' "$github_config")" -eq 1 ] || fail "dedicated GitHub block is missing or duplicated"
cmp -s "$tmp_root/personal.config.before" "$personal_home/.ssh/config.local" || fail "personal config.local was rewritten"

effective_github="$(ssh -F "$personal_home/.ssh/config" -G github.com 2>/dev/null)"
[ "$(printf '%s\n' "$effective_github" | awk '$1 == "identityagent" { print $2; exit }')" = none ] || fail "GitHub still uses an SSH agent"
[ "$(printf '%s\n' "$effective_github" | awk '$1 == "identityfile" { print $2; exit }')" = "$personal_home/.ssh/signing" ] || fail "GitHub does not prioritize the configured identity"
[ "$(printf '%s\n' "$effective_github" | awk '$1 == "identityfile" && $2 == "/tmp/preexisting-identity" { print $2; exit }')" = /tmp/preexisting-identity ] || fail "local wildcard identity behavior changed unexpectedly"

effective_unrelated="$(ssh -F "$personal_home/.ssh/config" -G unrelated.example 2>/dev/null)"
[ "$(printf '%s\n' "$effective_unrelated" | awk '$1 == "stricthostkeychecking" { print $2; exit }')" = true ] || fail "leading global SSH policy lost scope"
[ "$(printf '%s\n' "$effective_unrelated" | awk '$1 == "serveraliveinterval" { print $2; exit }')" = 42 ] || fail "leading Include lost scope"

cp "$github_config" "$tmp_root/personal.github.before"
configure \
  "$personal_home" \
  personal \
  "$personal_home/.ssh/signing.pub" \
  "$personal_home/.ssh/signing" >/dev/null
cmp -s "$tmp_root/personal.github.before" "$github_config" || fail "dedicated GitHub config is not idempotent"
cmp -s "$tmp_root/personal.config.before" "$personal_home/.ssh/config.local" || fail "rerun changed personal config.local"

proof_repo="$personal_home/proof"
HOME="$personal_home" git init -q "$proof_repo"
printf 'agentless signing proof\n' > "$proof_repo/proof.txt"
HOME="$personal_home" git -C "$proof_repo" add proof.txt
HOME="$personal_home" ssh-agent -a "$tmp_root/matching-agent.sock" sh -c "
  ssh-add \"\$1\" >/dev/null
  git -C \"\$2\" commit -q -m 'test: prove local signing ignores an active matching agent'
  git -C \"\$2\" verify-commit HEAD
" sh "$personal_home/.ssh/signing" "$proof_repo"

encrypted_home="$tmp_root/encrypted"
make_home "$encrypted_home"
make_encrypted_key "$encrypted_home/.ssh/signing"
configure \
  "$encrypted_home" \
  personal \
  "$encrypted_home/.ssh/signing.pub" \
  "$encrypted_home/.ssh/signing" >/dev/null
[ "$(HOME="$encrypted_home" git config --file "$encrypted_home/.gitconfig.local" --get user.signingkey)" = "$encrypted_home/.ssh/signing.pub" ] \
  || fail "encrypted signing key unexpectedly switched to unattended file-backed signing"
if HOME="$encrypted_home" git config --file "$encrypted_home/.gitconfig.local" --get gpg.ssh.program >/dev/null; then
  fail "encrypted signing key unexpectedly selected an agentless signing program"
fi

vault_home="$tmp_root/vault"
make_home "$vault_home"
make_key "$vault_home/.ssh/signing"
configure \
  "$vault_home" \
  personal \
  "$vault_home/.ssh/signing" \
  "$vault_home/.ssh/signing" \
  'Example Vault' >/dev/null
[ "$(HOME="$vault_home" git config --file "$vault_home/.gitconfig.local" --get user.signingkey)" = "$vault_home/.ssh/signing.pub" ] \
  || fail "1Password-backed signing unexpectedly selected a private key path"
[ "$(HOME="$vault_home" git config --file "$vault_home/.gitconfig.local" --get gpg.ssh.program)" = /Applications/1Password.app/Contents/MacOS/op-ssh-sign ] \
  || fail "1Password-backed signing program is missing"

migration_home="$tmp_root/migration"
make_home "$migration_home"
make_key "$migration_home/.ssh/signing"
cat > "$migration_home/.ssh/config.local" <<'EOF'
StrictHostKeyChecking yes

# uinaf-dotfiles: github-ssh begin
Host github.com
  IdentityAgent none
# uinaf-dotfiles: github-ssh end

Host unrelated.example
  User example
EOF
cat > "$tmp_root/migration.expected" <<'EOF'
StrictHostKeyChecking yes


Host unrelated.example
  User example
EOF
configure "$migration_home" personal "$migration_home/.ssh/signing.pub" "$migration_home/.ssh/signing" >/dev/null
cmp -s "$tmp_root/migration.expected" "$migration_home/.ssh/config.local" || fail "legacy marker migration changed unrelated SSH config"

devbox_home="$tmp_root/devbox"
make_home "$devbox_home"
make_key "$devbox_home/.ssh/signing"
configure "$devbox_home" devbox "$devbox_home/.ssh/signing.pub" >/dev/null
grep -q "^  IdentityFile $devbox_home/.ssh/signing$" "$devbox_home/.ssh/github.config" || fail "devbox did not resolve the signing private key"
[ "$(HOME="$devbox_home" git config --file "$devbox_home/.gitconfig.local" --get gpg.ssh.program)" = "$devbox_home/.local/libexec/uinaf/git-ssh-sign-agentless" ] \
  || fail "devbox local signing did not select the agentless signing program"

missing_home="$tmp_root/missing"
make_home "$missing_home"
make_key "$missing_home/.ssh/signing"
printf 'original git config\n' > "$missing_home/.gitconfig.local"
mkdir -p "$missing_home/.config/git"
printf 'original allowed signers\n' > "$missing_home/.config/git/allowed_signers.local"
assert_rejected_without_mutation \
  "$missing_home" 'identity file does not exist' \
  "$missing_home" personal "$missing_home/.ssh/signing.pub" "$missing_home/.ssh/missing"

invalid_auth_home="$tmp_root/invalid-auth"
make_home "$invalid_auth_home"
make_key "$invalid_auth_home/.ssh/signing"
printf 'not a private key\n' > "$invalid_auth_home/.ssh/not-a-key"
assert_rejected_without_mutation \
  "$invalid_auth_home" 'identity file is not an SSH private key' \
  "$invalid_auth_home" personal "$invalid_auth_home/.ssh/signing.pub" "$invalid_auth_home/.ssh/not-a-key"

invalid_signing_home="$tmp_root/invalid-signing"
make_home "$invalid_signing_home"
make_key "$invalid_signing_home/.ssh/auth"
printf 'not a public key\n' > "$invalid_signing_home/.ssh/signing.pub"
assert_rejected_without_mutation \
  "$invalid_signing_home" 'does not resolve to a valid SSH public key' \
  "$invalid_signing_home" personal "$invalid_signing_home/.ssh/signing.pub" "$invalid_signing_home/.ssh/auth"

permissive_home="$tmp_root/permissive"
make_home "$permissive_home"
make_key "$permissive_home/.ssh/signing"
chmod 0644 "$permissive_home/.ssh/signing"
assert_rejected_without_mutation \
  "$permissive_home" 'identity file permissions must be owner-only' \
  "$permissive_home" personal "$permissive_home/.ssh/signing.pub" "$permissive_home/.ssh/signing"

unmanaged_github_config_home="$tmp_root/unmanaged-github-config"
make_home "$unmanaged_github_config_home"
make_key "$unmanaged_github_config_home/.ssh/signing"
cat > "$unmanaged_github_config_home/.ssh/github.config" <<'EOF'
Host github.com
  ProxyCommand false
EOF
assert_rejected_without_mutation \
  "$unmanaged_github_config_home" 'existing file is not managed exclusively by uinaf dotfiles' \
  "$unmanaged_github_config_home" personal "$unmanaged_github_config_home/.ssh/signing.pub" "$unmanaged_github_config_home/.ssh/signing"

conflict_home="$tmp_root/conflict"
make_home "$conflict_home"
make_key "$conflict_home/.ssh/signing"
cat > "$conflict_home/.ssh/config.local" <<'EOF'
Host=github.com
  ProxyCommand false
EOF
assert_rejected_without_mutation \
  "$conflict_home" 'unmanaged Host github.com entry exists' \
  "$conflict_home" personal "$conflict_home/.ssh/signing.pub" "$conflict_home/.ssh/signing"

malformed_home="$tmp_root/malformed"
make_home "$malformed_home"
make_key "$malformed_home/.ssh/signing"
printf '# uinaf-dotfiles: github-ssh begin\n' > "$malformed_home/.ssh/config.local"
assert_rejected_without_mutation \
  "$malformed_home" 'malformed managed block' \
  "$malformed_home" personal "$malformed_home/.ssh/signing.pub" "$malformed_home/.ssh/signing"

public_only_home="$tmp_root/public-only"
make_home "$public_only_home"
make_key "$public_only_home/.ssh/signing"
rm "$public_only_home/.ssh/signing"
assert_rejected_without_mutation \
  "$public_only_home" 'matching private key does not exist' \
  "$public_only_home" devbox "$public_only_home/.ssh/signing.pub"

printf 'ok Git bootstrap preserves SSH scope and signs locally while ignoring an active matching agent\n'
