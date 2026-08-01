#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"
# shellcheck source=scripts/lib/config-paths.sh
. "$repo_root/scripts/lib/config-paths.sh"

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  [ "$actual" = "$expected" ] || fail "$label: expected '$expected', got '$actual'"
}

render_target() {
  local profile="$1"
  local target="$2"
  local home="$tmp_root/$profile"
  local data

  mkdir -p "$home"
  data="$(printf '{"dotfilesProfile":"%s"}' "$profile")"
  chezmoi \
    --source "$repo_root/chezmoi" \
    --destination "$home" \
    --override-data "$data" \
    cat "$home/$target"
}

assert_eq workstation "$(dotfiles_normalize_profile personal)" "personal compatibility alias"
assert_eq workstation "$(dotfiles_normalize_profile workstation)" "workstation profile"
assert_eq devbox "$(dotfiles_normalize_profile devbox)" "devbox profile"
assert_eq assistant "$(dotfiles_normalize_profile assistant)" "assistant profile"
if dotfiles_normalize_profile unsupported >/dev/null 2>&1; then
  fail "unsupported profile was accepted"
fi

profile_home="$tmp_root/profile-resolution"
mkdir -p "$profile_home/.config/dotfiles"
printf ' \tassistant\r\n' > "$profile_home/.config/dotfiles/profile"
assert_eq assistant "$(HOME="$profile_home" DOTFILES_PROFILE=workstation dotfiles_resolve_profile)" \
  "stored assistant profile precedence"
rm "$profile_home/.config/dotfiles/profile"
assert_eq devbox "$(HOME="$profile_home" DOTFILES_PROFILE=' devbox ' dotfiles_resolve_profile)" \
  "environment profile fallback"
if HOME="$profile_home" DOTFILES_PROFILE='' dotfiles_resolve_profile >/dev/null 2>&1; then
  fail "missing profile was accepted"
elif [ "$?" -ne 1 ]; then
  fail "missing profile did not return its distinct status"
fi
if HOME="$profile_home" DOTFILES_PROFILE=invalid dotfiles_resolve_profile >/dev/null 2>&1; then
  fail "invalid profile was accepted"
elif [ "$?" -ne 2 ]; then
  fail "invalid profile did not return its distinct status"
fi
ln -s "$profile_home/missing-profile" "$profile_home/.config/dotfiles/profile"
if HOME="$profile_home" DOTFILES_PROFILE=workstation dotfiles_resolve_profile >/dev/null 2>&1; then
  fail "dangling persisted profile fell back to the environment"
elif [ "$?" -ne 3 ]; then
  fail "unreadable persisted profile did not return its distinct status"
fi
rm "$profile_home/.config/dotfiles/profile"
printf 'assistant\nextra\n' > "$profile_home/.config/dotfiles/profile"
if HOME="$profile_home" dotfiles_resolve_profile >/dev/null 2>&1; then
  fail "multi-record persisted profile was accepted"
fi
rm "$profile_home/.config/dotfiles/profile"
printf 'assistant\n' > "$profile_home/profile-target"
ln -s "$profile_home/profile-target" "$profile_home/.config/dotfiles/profile"
if HOME="$profile_home" dotfiles_resolve_profile >/dev/null 2>&1; then
  fail "symlinked persisted profile was accepted"
fi
rm "$profile_home/.config/dotfiles/profile"
printf 'assistant\n' > "$profile_home/.config/dotfiles/profile"
chmod 0666 "$profile_home/.config/dotfiles/profile"
if HOME="$profile_home" dotfiles_resolve_profile >/dev/null 2>&1; then
  fail "group/world-writable persisted profile was accepted"
fi
chmod 0644 "$profile_home/.config/dotfiles/profile"
rm "$profile_home/.config/dotfiles/profile"

config_home="$tmp_root/config-paths"
mkdir -p "$config_home/.config/uinaf"
printf 'legacy\n' > "$config_home/.config/uinaf/devbox.env"
assert_eq "$config_home/.config/uinaf/devbox.env" \
  "$(HOME="$config_home" dotfiles_resolve_config_file '' devbox.env)" \
  "legacy config fallback"
mkdir -p "$config_home/.config/dotfiles"
printf 'canonical\n' > "$config_home/.config/dotfiles/devbox.env"
assert_eq "$config_home/.config/dotfiles/devbox.env" \
  "$(HOME="$config_home" dotfiles_resolve_config_file '' devbox.env)" \
  "canonical config precedence"
ln -s "$config_home/.config/uinaf/devbox.env" "$config_home/.config/uinaf/symlinked.env"
if HOME="$config_home" dotfiles_resolve_config_file '' symlinked.env >/dev/null 2>&1; then
  fail "legacy config fallback accepted a symlink"
fi

legacy_home="$tmp_root/legacy-profile"
mkdir -p "$legacy_home/.config/uinaf"
printf 'assistant\n' > "$legacy_home/.config/uinaf/profile"
printf 'DEVBOX_USER=legacy\n' > "$legacy_home/.config/uinaf/devbox.env"
HOME="$legacy_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" >/dev/null
assert_eq assistant "$(sed -n '1p' "$legacy_home/.config/dotfiles/profile")" "migrated legacy profile marker"
[ -f "$legacy_home/.config/dotfiles/devbox.env" ] || fail "legacy config was not migrated"
[ ! -e "$legacy_home/.config/uinaf" ] || fail "empty legacy config directory was retained"

preview_home="$tmp_root/legacy-preview"
mkdir -p "$preview_home/.config/uinaf"
printf 'GH_ACCEPTED_SCOPES="fixture"\n' > "$preview_home/.config/uinaf/audit.env"
preview_output="$(HOME="$preview_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant --dry-run)"
printf '%s\n' "$preview_output" | grep -Fq \
  "would back up legacy config $preview_home/.config/uinaf/audit.env -> $preview_home/.config/dotfiles/audit.env.backup." \
  || fail "legacy migration preview omitted the managed config backup"
[ -f "$preview_home/.config/uinaf/audit.env" ] || fail "legacy migration preview mutated its source"
[ ! -e "$preview_home/.config/dotfiles/audit.env" ] || fail "legacy migration preview created its target"

failure_home="$tmp_root/legacy-failure"
failure_bin="$tmp_root/legacy-failure-bin"
real_chezmoi="$(command -v chezmoi)"
mkdir -p "$failure_home/.config/uinaf" "$failure_bin"
printf 'DEVBOX_USER=legacy\n' > "$failure_home/.config/uinaf/devbox.env"
cat > "$failure_bin/chezmoi" <<'EOF'
#!/usr/bin/env bash
for argument in "$@"; do
  if [ "$argument" = apply ]; then
    exit 42
  fi
done
exec "${REAL_CHEZMOI:?}" "$@"
EOF
chmod +x "$failure_bin/chezmoi"
if HOME="$failure_home" REAL_CHEZMOI="$real_chezmoi" PATH="$failure_bin:$PATH" \
  "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null 2>&1; then
  fail "legacy migration fixture did not force an apply failure"
fi
[ -f "$failure_home/.config/uinaf/devbox.env" ] \
  || fail "failed dotfiles apply removed the working legacy config"

symlink_home="$tmp_root/legacy-symlink"
mkdir -p "$symlink_home/.config/uinaf/private"
printf 'DEVBOX_USER=legacy\n' > "$symlink_home/.config/uinaf/private/devbox.env"
ln -s private/devbox.env "$symlink_home/.config/uinaf/devbox.env"
if HOME="$symlink_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null 2>&1; then
  fail "legacy config migration accepted a relative symlink"
fi
[ "$(readlink "$symlink_home/.config/uinaf/devbox.env")" = private/devbox.env ] \
  || fail "rejected legacy config symlink was mutated"
[ ! -e "$symlink_home/.config/dotfiles/devbox.env" ] \
  || fail "rejected legacy config symlink created a canonical target"

symlink_dir_home="$tmp_root/legacy-symlink-directory"
symlink_dir_target="$tmp_root/legacy-symlink-directory-target"
mkdir -p "$symlink_dir_home/.config" "$symlink_dir_target"
printf 'DEVBOX_USER=external\n' > "$symlink_dir_target/devbox.env"
ln -s "$symlink_dir_target" "$symlink_dir_home/.config/uinaf"
if HOME="$symlink_dir_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null 2>&1; then
  fail "legacy config migration accepted a symlinked directory"
fi
[ -f "$symlink_dir_target/devbox.env" ] \
  || fail "rejected legacy config directory removed an external file"

task_home="$tmp_root/task-profile"
mkdir -p "$task_home"
(
  cd "$repo_root"
  HOME="$task_home" ./.mise/tasks/dotfiles/diff --profile assistant >/dev/null
  HOME="$task_home" ./.mise/tasks/dotfiles/apply --profile assistant >/dev/null
)
assert_eq assistant "$(sed -n '1p' "$task_home/.config/dotfiles/profile")" \
  "dotfiles task profile forwarding"

assistant_files="$(dotfiles_profile_brewfiles assistant)"
assert_eq "$(printf 'Brewfile\nBrewfile.assistant')" "$assistant_files" "assistant Brewfile layers"
devbox_files="$(dotfiles_profile_brewfiles devbox)"
assert_eq "$(printf 'Brewfile\nBrewfile.developer\nBrewfile.devbox')" "$devbox_files" "devbox Brewfile layers"
workstation_files="$(dotfiles_profile_brewfiles workstation)"
assert_eq "$(printf 'Brewfile\nBrewfile.developer\nBrewfile.workstation')" "$workstation_files" "workstation Brewfile layers"

assistant_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile assistant)"
assert_eq apply-dotfiles "$assistant_steps" "assistant install steps"
developer_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile workstation)"
for step in apply-dotfiles trust-agent-worktrees install-gh-extensions install-native-pnpm configure-codex; do
  printf '%s\n' "$developer_steps" | grep -Fqx "$step" || fail "workstation install missed $step"
done
devbox_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile devbox)"
assert_eq "$developer_steps" "$devbox_steps" "devbox developer install steps"

install_fixture="$tmp_root/install-fixture"
install_log="$tmp_root/install-fixture.log"
mkdir -p "$install_fixture/scripts/bootstrap" "$install_fixture/scripts/lib" "$install_fixture/bin"
cp "$repo_root/scripts/bootstrap/install.sh" "$install_fixture/scripts/bootstrap/install.sh"
cp "$repo_root/scripts/lib/profile.sh" "$install_fixture/scripts/lib/profile.sh"
for helper in apply-dotfiles.sh trust-agent-worktrees.sh install-gh-extensions.sh configure-codex.sh; do
cat > "$install_fixture/scripts/bootstrap/$helper" <<'EOF'
#!/usr/bin/env bash
printf '%s' "$(basename "$0")" >> "${DOTFILES_INSTALL_LOG:?}"
[ "$#" -eq 0 ] || printf ' %s' "$@" >> "${DOTFILES_INSTALL_LOG:?}"
printf '\n' >> "${DOTFILES_INSTALL_LOG:?}"
if [ "${DOTFILES_INSTALL_READ_STDIN:-}" = "$(basename "$0")" ]; then
  IFS= read -r stdin_value || stdin_value=eof
  printf 'stdin %s\n' "$stdin_value" >> "${DOTFILES_INSTALL_LOG:?}"
fi
EOF
  chmod 0700 "$install_fixture/scripts/bootstrap/$helper"
done
for command_name in corepack npm codex; do
cat > "$install_fixture/bin/$command_name" <<'EOF'
#!/usr/bin/env bash
printf '%s' "$(basename "$0")" >> "${DOTFILES_INSTALL_LOG:?}"
[ "$#" -eq 0 ] || printf ' %s' "$@" >> "${DOTFILES_INSTALL_LOG:?}"
printf '\n' >> "${DOTFILES_INSTALL_LOG:?}"
EOF
  chmod 0700 "$install_fixture/bin/$command_name"
done

: > "$install_log"
PATH="$install_fixture/bin:$PATH" \
DOTFILES_INSTALL_LOG="$install_log" \
HOME="$tmp_root/install-assistant-home" \
  "$install_fixture/scripts/bootstrap/install.sh" --profile assistant
assert_eq 'apply-dotfiles.sh --profile assistant' "$(cat "$install_log")" \
  "assistant install execution"

: > "$install_log"
PATH="$install_fixture/bin:$PATH" \
DOTFILES_INSTALL_LOG="$install_log" \
HOME="$tmp_root/install-devbox-home" \
  "$install_fixture/scripts/bootstrap/install.sh" --profile devbox
expected_install_log="$(cat <<'EOF'
apply-dotfiles.sh --profile devbox
trust-agent-worktrees.sh
install-gh-extensions.sh
corepack disable pnpm
npm install --global --allow-scripts=pnpm pnpm@12.0.0-beta.2
configure-codex.sh
EOF
)"
assert_eq "$expected_install_log" "$(cat "$install_log")" "devbox install execution"

: > "$install_log"
printf 'caller-input\n' | \
  PATH="$install_fixture/bin:$PATH" \
  DOTFILES_INSTALL_LOG="$install_log" \
  DOTFILES_INSTALL_READ_STDIN=apply-dotfiles.sh \
  HOME="$tmp_root/install-stdin-home" \
    "$install_fixture/scripts/bootstrap/install.sh" --profile assistant
assert_eq "$(printf 'apply-dotfiles.sh --profile assistant\nstdin caller-input')" \
  "$(cat "$install_log")" \
  "install step caller stdin"

assert_install_rejected() {
  local label="$1"
  shift

  if PATH="$install_fixture/bin:$PATH" \
    DOTFILES_INSTALL_LOG="$install_log" \
    HOME="$tmp_root/install-invalid-home" \
      "$install_fixture/scripts/bootstrap/install.sh" "$@" >/dev/null 2>&1; then
    fail "install accepted invalid arguments: $label"
  fi
}

assert_install_rejected 'missing profile'
assert_install_rejected 'unsupported profile' --profile unsupported
assert_install_rejected 'unknown option' --unknown

assistant_mise="$(render_target assistant .config/mise/config.toml)"
for expected in 'node = "24.18.0"' 'python = "3.13"' 'uv = "0.11.4"'; do
  printf '%s\n' "$assistant_mise" | grep -Fqx "$expected" || fail "assistant mise config missed $expected"
done
for rejected in 'bun =' 'java =' 'go =' 'playwright' 'vite-plus' 'trusted_config_paths' 'pnpm@'; do
  if printf '%s\n' "$assistant_mise" | grep -Fq "$rejected"; then
    fail "assistant mise config included developer setting $rejected"
  fi
done

workstation_mise="$(render_target workstation .config/mise/config.toml)"
for expected in 'bun = "1.3.10"' 'java = "temurin-21"' 'go = "1.26.2"' 'trusted_config_paths'; do
  printf '%s\n' "$workstation_mise" | grep -Fq "$expected" || fail "workstation mise config missed $expected"
done

devbox_mise="$(render_target devbox .config/mise/config.toml)"
assert_eq "$workstation_mise" "$devbox_mise" "devbox developer mise config"

assert_eq assistant "$(render_target assistant .config/dotfiles/profile)" "rendered assistant profile"

assistant_managed="$({
  data='{"dotfilesProfile":"assistant"}'
  chezmoi \
    --source "$repo_root/chezmoi" \
    --destination "$tmp_root/assistant" \
    --override-data "$data" \
    managed --path-style relative
})"
printf '%s\n' "$assistant_managed" | grep -Fqx '.config/dotfiles/profile' || fail "assistant profile marker is unmanaged"
printf '%s\n' "$assistant_managed" | grep -Fqx '.gitconfig' \
  || fail "assistant profile does not manage .gitconfig"
if printf '%s\n' "$assistant_managed" | grep -Eq '^(\.codex|\.config/1Password/ssh|\.config/git|\.config/zed|\.local/libexec/dotfiles/git-ssh-sign-agentless|\.ssh|Library/Application Support/com.mitchellh.ghostty)(/|$)'; then
  fail "assistant profile manages developer or identity state"
fi

workstation_managed="$({
  data='{"dotfilesProfile":"workstation"}'
  chezmoi \
    --source "$repo_root/chezmoi" \
    --destination "$tmp_root/workstation" \
    --override-data "$data" \
    managed --path-style relative
})"
for required_path in \
  '.config/git/allowed_signers' \
  '.config/zed/settings.json' \
  '.gitconfig' \
  '.local/libexec/dotfiles/git-ssh-sign-agentless' \
  '.ssh/config' \
  'Library/Application Support/com.mitchellh.ghostty/config'; do
  printf '%s\n' "$workstation_managed" | grep -Fqx "$required_path" \
    || fail "workstation profile does not manage $required_path"
done

devbox_managed="$({
  data='{"dotfilesProfile":"devbox"}'
  chezmoi \
    --source "$repo_root/chezmoi" \
    --destination "$tmp_root/devbox" \
    --override-data "$data" \
    managed --path-style relative
})"
for required_path in \
  '.config/git/allowed_signers' \
  '.config/zed/settings.json' \
  '.gitconfig' \
  '.local/libexec/dotfiles/git-ssh-sign-agentless' \
  '.ssh/config'; do
  printf '%s\n' "$devbox_managed" | grep -Fqx "$required_path" \
    || fail "devbox profile does not manage $required_path"
done

assistant_home="$tmp_root/assistant-applied"
mkdir -p "$assistant_home"
HOME="$assistant_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null
assert_eq assistant "$(sed -n '1p' "$assistant_home/.config/dotfiles/profile")" "applied assistant profile"

preservation_home="$tmp_root/assistant-preserves-developer-state"
mkdir -p \
  "$preservation_home/.config/1Password/ssh" \
  "$preservation_home/.codex/browser"
ln -s "$repo_root/home/.config/1Password/ssh/agent.toml" \
  "$preservation_home/.config/1Password/ssh/agent.toml"
ln -s "$repo_root/home/.codex/config.toml" "$preservation_home/.codex/config.toml"
ln -s "$repo_root/home/.codex/browser/config.toml" \
  "$preservation_home/.codex/browser/config.toml"
HOME="$preservation_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null
for preserved_path in \
  "$preservation_home/.config/1Password/ssh/agent.toml" \
  "$preservation_home/.codex/config.toml" \
  "$preservation_home/.codex/browser/config.toml"; do
  [ -L "$preserved_path" ] || fail "assistant apply mutated prior developer state at $preserved_path"
done

for rejected_path in \
  "$assistant_home/.config/git" \
  "$assistant_home/.config/zed" \
  "$assistant_home/.local/libexec/dotfiles/git-ssh-sign-agentless" \
  "$assistant_home/.ssh" \
  "$assistant_home/Library/Application Support/com.mitchellh.ghostty"; do
  if [ -e "$rejected_path" ] || [ -L "$rejected_path" ]; then
    fail "assistant apply created forbidden state at $rejected_path"
  fi
done
assistant_gitconfig="$(cat "$assistant_home/.gitconfig")"
printf '%s\n' "$assistant_gitconfig" | grep -Fqx '[core]' \
  || fail "assistant Git base config missed core settings"
printf '%s\n' "$assistant_gitconfig" | grep -Fqx '[include]' \
  || fail "assistant Git base config missed workload identity include"
if printf '%s\n' "$assistant_gitconfig" | grep -Eq '^\[(credential|gpg)|gh auth git-credential|signing'; then
  fail "assistant Git base config included developer authentication or signing settings"
fi
identity_home="$tmp_root/assistant-git-boundary"
private_key_type="$(printf '%s %s' PRIVATE KEY)"

run_assistant_git_boundary() {
  env \
    -u SSH_AUTH_SOCK \
    -u GIT_CONFIG_GLOBAL \
    -u GIT_CONFIG_SYSTEM \
    -u GIT_CONFIG_NOSYSTEM \
    -u GIT_CONFIG_COUNT \
    -u GIT_CONFIG_PARAMETERS \
    -u GIT_AUTHOR_NAME \
    -u GIT_AUTHOR_EMAIL \
    -u GIT_COMMITTER_NAME \
    -u GIT_COMMITTER_EMAIL \
    HOME="$identity_home" \
    XDG_CONFIG_HOME="$identity_home/.config" \
    GH_CONFIG_DIR="${identity_gh_config_dir:-$identity_home/.config/gh}" \
    "$repo_root/scripts/verify/assistant-git-boundary.sh"
}

prepare_identity_home() {
  mkdir -p "$identity_home"
  find "$identity_home" -mindepth 1 -depth -delete
  identity_gh_config_dir="$identity_home/.config/gh"
  HOME="$identity_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null
  HOME="$identity_home" \
  GIT_USER_NAME='Example Workload' \
  GIT_USER_EMAIL='example-workload@users.noreply.github.com' \
    "$repo_root/scripts/bootstrap/configure-git.sh" --profile assistant --non-interactive >/dev/null
}

assert_assistant_git_boundary_rejected() {
  local label="$1"

  if run_assistant_git_boundary >/dev/null 2>&1; then
    fail "assistant Git boundary accepted $label"
  fi
}

prepare_identity_home
run_assistant_git_boundary >/dev/null

prepare_identity_home
git config --file "$identity_home/.gitconfig.local" credential.helper store
assert_assistant_git_boundary_rejected "a persisted credential helper"

prepare_identity_home
git config --file "$identity_home/.gitconfig" --unset-all include.path
git config --file "$identity_home/.gitconfig" --add include.path "~"'/.hidden-gitconfig'
git config --file "$identity_home/.gitconfig" --add include.path "~"'/.gitconfig.local'
assert_assistant_git_boundary_rejected "an additional Git include path"

prepare_identity_home
mkdir -p "$identity_home/.config/git"
printf '[user]\n\tname = Hidden Identity\n' > "$identity_home/.config/git/config"
assert_assistant_git_boundary_rejected "additional user-home Git config"

prepare_identity_home
mkdir -p "$identity_home/.local/libexec/dotfiles"
: > "$identity_home/.local/libexec/dotfiles/git-ssh-sign-agentless"
assert_assistant_git_boundary_rejected "a persisted Git signing helper"

prepare_identity_home
mkdir -p "$identity_home/.ssh"
printf 'Host github.com\n  IdentityFile ~/.ssh/human-key\n' > "$identity_home/.ssh/config"
assert_assistant_git_boundary_rejected "user-home outbound SSH configuration"

prepare_identity_home
mkdir -p "$identity_home/.ssh"
printf '%s\n' "-----BEGIN OPENSSH ${private_key_type}-----" > "$identity_home/.ssh/id_ed25519"
assert_assistant_git_boundary_rejected "a user-home SSH private key"

prepare_identity_home
mkdir -p "$identity_home/.ssh"
printf '\n%s\n' "-----BEGIN OPENSSH ${private_key_type}-----" > "$identity_home/.ssh/id_ed25519"
assert_assistant_git_boundary_rejected "a private key after a leading blank line"

prepare_identity_home
mkdir -p "$identity_home/.ssh"
printf '%s\n' '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----' > "$identity_home/.ssh/id_ssh2"
assert_assistant_git_boundary_rejected "an SSH2 private key"

prepare_identity_home
mkdir -p "$identity_home/.ssh"
printf '%s\n' 'PuTTY-User-Key-File-3: ssh-ed25519' > "$identity_home/.ssh/id_putty"
assert_assistant_git_boundary_rejected "a PuTTY private key"

prepare_identity_home
mkdir -p "$identity_home/.ssh/keys"
printf '%s\n' "-----BEGIN OPENSSH ${private_key_type}-----" > "$identity_home/.ssh/keys/id_ed25519"
assert_assistant_git_boundary_rejected "a nested user-home SSH private key"

prepare_identity_home
mkdir -p "$identity_home/.ssh"
printf '%s\n' "-----BEGIN OPENSSH ${private_key_type}-----" > "$identity_home/.ssh/id_ed25519"
chmod 000 "$identity_home/.ssh/id_ed25519"
assert_assistant_git_boundary_rejected "an unreadable user-home SSH file"
chmod 0600 "$identity_home/.ssh/id_ed25519"

prepare_identity_home
external_ssh_keys="$tmp_root/external-ssh-keys"
mkdir -p "$external_ssh_keys"
printf '%s\n' "-----BEGIN OPENSSH ${private_key_type}-----" > "$external_ssh_keys/id_ed25519"
mkdir -p "$identity_home/.ssh"
ln -s "$external_ssh_keys" "$identity_home/.ssh/keys"
assert_assistant_git_boundary_rejected "a symlinked user-home SSH key directory"

prepare_identity_home
printf '[credential "https://github.com"]\n\thelper = store\n' \
  > "$identity_home/.gitconfig.backup.20260801000000"
assert_assistant_git_boundary_rejected "a persisted previous Git base config backup"

prepare_identity_home
printf 'https://x-access-token:fixture@github.com\n' > "$identity_home/.git-credentials"
assert_assistant_git_boundary_rejected "a persisted Git credential store"

prepare_identity_home
mkdir -p "$identity_home/custom-xdg/git"
printf 'https://x-access-token:fixture@github.com\n' > "$identity_home/custom-xdg/git/credentials"
if env \
  -u SSH_AUTH_SOCK \
  -u GIT_CONFIG_GLOBAL \
  -u GIT_CONFIG_SYSTEM \
  -u GIT_CONFIG_NOSYSTEM \
  -u GIT_CONFIG_COUNT \
  HOME="$identity_home" \
  XDG_CONFIG_HOME="$identity_home/custom-xdg" \
  GH_CONFIG_DIR="$identity_home/.config/gh" \
    "$repo_root/scripts/verify/assistant-git-boundary.sh" >/dev/null 2>&1; then
  fail "assistant Git boundary accepted an XDG Git credential store"
fi

prepare_identity_home
if env \
  -u SSH_AUTH_SOCK \
  HOME="$identity_home" \
  XDG_CONFIG_HOME="$identity_home/.config" \
  GH_CONFIG_DIR="$identity_home/.config/gh" \
  GIT_CONFIG_GLOBAL="$identity_home/attacker.gitconfig" \
    "$repo_root/scripts/verify/assistant-git-boundary.sh" >/dev/null 2>&1; then
  fail "assistant Git boundary accepted an ambient Git config override"
fi

prepare_identity_home
if env \
  -u SSH_AUTH_SOCK \
  -u GIT_CONFIG_GLOBAL \
  -u GIT_CONFIG_SYSTEM \
  HOME="$identity_home" \
  XDG_CONFIG_HOME="$identity_home/.config" \
  GH_CONFIG_DIR="$identity_home/.config/gh" \
  GIT_CONFIG_NOSYSTEM=1 \
    "$repo_root/scripts/verify/assistant-git-boundary.sh" >/dev/null 2>&1; then
  fail "assistant Git boundary accepted GIT_CONFIG_NOSYSTEM"
fi

prepare_identity_home
if env \
  -u SSH_AUTH_SOCK \
  -u GIT_CONFIG_GLOBAL \
  -u GIT_CONFIG_SYSTEM \
  -u GIT_CONFIG_NOSYSTEM \
  -u GIT_CONFIG_COUNT \
  -u GIT_CONFIG_PARAMETERS \
  -u GIT_AUTHOR_EMAIL \
  -u GIT_COMMITTER_NAME \
  -u GIT_COMMITTER_EMAIL \
  HOME="$identity_home" \
  XDG_CONFIG_HOME="$identity_home/.config" \
  GH_CONFIG_DIR="$identity_home/.config/gh" \
  GIT_AUTHOR_NAME='Ambient Human' \
    "$repo_root/scripts/verify/assistant-git-boundary.sh" >/dev/null 2>&1; then
  fail "assistant Git boundary accepted an ambient author identity override"
fi

prepare_identity_home
mkdir -p "$identity_home/custom-gh"
mkdir -p "$identity_home/.config/gh"
printf 'github.com:\n  user: example-human\n' > "$identity_home/.config/gh/hosts.yml"
identity_gh_config_dir="$identity_home/custom-gh"
assert_assistant_git_boundary_rejected "persisted GitHub CLI configuration"

printf 'ok profile aliases, layers, applied dotfiles, and workload Git identity\n'
