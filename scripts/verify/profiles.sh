#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"

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
  data="$(printf '{"uinafProfile":"%s"}' "$profile")"
  chezmoi \
    --source "$repo_root/chezmoi" \
    --destination "$home" \
    --override-data "$data" \
    cat "$home/$target"
}

assert_eq workstation "$(uinaf_normalize_profile personal)" "personal compatibility alias"
assert_eq workstation "$(uinaf_normalize_profile workstation)" "workstation profile"
assert_eq devbox "$(uinaf_normalize_profile devbox)" "devbox profile"
assert_eq assistant "$(uinaf_normalize_profile assistant)" "assistant profile"
if uinaf_normalize_profile unsupported >/dev/null 2>&1; then
  fail "unsupported profile was accepted"
fi

assistant_files="$(uinaf_profile_brewfiles assistant)"
assert_eq "$(printf 'Brewfile\nBrewfile.assistant')" "$assistant_files" "assistant Brewfile layers"
devbox_files="$(uinaf_profile_brewfiles devbox)"
assert_eq "$(printf 'Brewfile\nBrewfile.developer\nBrewfile.devbox')" "$devbox_files" "devbox Brewfile layers"
workstation_files="$(uinaf_profile_brewfiles workstation)"
assert_eq "$(printf 'Brewfile\nBrewfile.developer\nBrewfile.workstation')" "$workstation_files" "workstation Brewfile layers"

assistant_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile assistant)"
assert_eq apply-dotfiles "$assistant_steps" "assistant install steps"
developer_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile workstation)"
for step in apply-dotfiles trust-agent-worktrees install-gh-extensions install-native-pnpm configure-codex; do
  printf '%s\n' "$developer_steps" | grep -Fqx "$step" || fail "workstation install missed $step"
done

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

assert_eq assistant "$(render_target assistant .config/uinaf/profile)" "rendered assistant profile"

assistant_managed="$({
  data='{"uinafProfile":"assistant"}'
  chezmoi \
    --source "$repo_root/chezmoi" \
    --destination "$tmp_root/assistant" \
    --override-data "$data" \
    managed --path-style relative
})"
printf '%s\n' "$assistant_managed" | grep -Fqx '.config/uinaf/profile' || fail "assistant profile marker is unmanaged"
for required_path in '.gitconfig' '.local/bin/uinaf-git-app'; do
  printf '%s\n' "$assistant_managed" | grep -Fqx "$required_path" \
    || fail "assistant profile does not manage $required_path"
done
if printf '%s\n' "$assistant_managed" | grep -Eq '^(\.config/git|\.config/zed|\.local/libexec/uinaf/git-ssh-sign-agentless|\.ssh|Library/Application Support/com.mitchellh.ghostty)(/|$)'; then
  fail "assistant profile manages developer or identity state"
fi

workstation_managed="$({
  data='{"uinafProfile":"workstation"}'
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
  '.local/libexec/uinaf/git-ssh-sign-agentless' \
  '.ssh/config' \
  'Library/Application Support/com.mitchellh.ghostty/config'; do
  printf '%s\n' "$workstation_managed" | grep -Fqx "$required_path" \
    || fail "workstation profile does not manage $required_path"
done

assistant_home="$tmp_root/assistant-applied"
mkdir -p "$assistant_home"
HOME="$assistant_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null
assert_eq assistant "$(sed -n '1p' "$assistant_home/.config/uinaf/profile")" "applied assistant profile"
for rejected_path in \
  "$assistant_home/.config/git" \
  "$assistant_home/.config/zed" \
  "$assistant_home/.local/libexec/uinaf/git-ssh-sign-agentless" \
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
assistant_git_app="$assistant_home/.local/bin/uinaf-git-app"
[ -x "$assistant_git_app" ] || fail "assistant GitHub App wrapper is not executable"
assert_eq x-access-token "$(
  UINAF_GITHUB_APP_ASKPASS=1 \
  GITHUB_APP_INSTALLATION_TOKEN=token-fixture \
    "$assistant_git_app" "Username for 'https://github.com/OWNER/REPOSITORY.git': "
)" "GitHub App HTTPS username"
assert_eq token-fixture "$(
  UINAF_GITHUB_APP_ASKPASS=1 \
  GITHUB_APP_INSTALLATION_TOKEN=token-fixture \
    "$assistant_git_app" "Password for 'https://x-access-token@github.com/OWNER/REPOSITORY.git': "
)" "GitHub App HTTPS password"
if UINAF_GITHUB_APP_ASKPASS=1 \
  GITHUB_APP_INSTALLATION_TOKEN=token-fixture \
    "$assistant_git_app" "Password for 'https://example.com/OWNER/REPOSITORY.git': " >/dev/null 2>&1; then
  fail "GitHub App askpass returned a token for a non-GitHub host"
fi
if UINAF_GITHUB_APP_ASKPASS=1 \
  GITHUB_APP_INSTALLATION_TOKEN=token-fixture \
    "$assistant_git_app" "Password for 'http://example.com/https://github.com/OWNER/REPOSITORY.git': " >/dev/null 2>&1; then
  fail "GitHub App askpass trusted a GitHub URL embedded under another host"
fi
if UINAF_GITHUB_APP_ASKPASS=1 \
  GITHUB_APP_INSTALLATION_TOKEN=token-fixture \
    "$assistant_git_app" "Password for 'https://github.com:443@example.com/OWNER/REPOSITORY.git': " >/dev/null 2>&1; then
  fail "GitHub App askpass confused userinfo with the GitHub authority"
fi
if UINAF_GITHUB_APP_ASKPASS=1 \
  GITHUB_APP_INSTALLATION_TOKEN=token-fixture \
    "$assistant_git_app" "Password  for 'https://x-access-token@github.com/OWNER/REPOSITORY.git': " >/dev/null 2>&1; then
  fail "GitHub App askpass accepted non-literal prompt spacing"
fi
if UINAF_GITHUB_APP_ASKPASS=1 \
  GITHUB_APP_INSTALLATION_TOKEN=token-fixture \
    "$assistant_git_app" "Password for 'https://x-access-token@github.com/OWNER/REPOSITORY.git':" >/dev/null 2>&1; then
  fail "GitHub App askpass accepted a prompt without the literal trailing space"
fi
GITHUB_APP_INSTALLATION_TOKEN=token-fixture "$assistant_git_app" --version >/dev/null

credential_helper="$tmp_root/credential-helper"
credential_helper_log="$tmp_root/credential-helper.log"
credential_config="$tmp_root/credential-config"
cat > "$credential_helper" <<EOF
#!/usr/bin/env bash
printf 'invoked\\n' >> '$credential_helper_log'
EOF
chmod 0700 "$credential_helper"
git config --file "$credential_config" credential.helper "$credential_helper"
git config --file "$credential_config" 'credential.https://github.com.helper' "$credential_helper"
git config --file "$credential_config" alias.print-locale '!env | sed -n "s/^LC_ALL=//p"'
assert_eq C "$(
  LC_ALL=POSIX \
  GIT_CONFIG_GLOBAL="$credential_config" \
  GITHUB_APP_INSTALLATION_TOKEN=token-fixture \
    "$assistant_git_app" print-locale
)" "GitHub App wrapper child locale"
credential_output="$(
  printf 'url=https://github.com/OWNER/REPOSITORY.git\n\n' \
    | GIT_CONFIG_GLOBAL="$credential_config" \
      GITHUB_APP_INSTALLATION_TOKEN=token-fixture \
        "$assistant_git_app" credential fill
)"
[ ! -e "$credential_helper_log" ] \
  || fail "GitHub App wrapper invoked an ambient credential helper"
printf '%s\n' "$credential_output" | grep -Fqx 'username=x-access-token' \
  || fail "GitHub App wrapper did not supply the HTTPS username"
printf '%s\n' "$credential_output" | grep -Fqx 'password=token-fixture' \
  || fail "GitHub App wrapper did not supply the installation token"

identity_home="$tmp_root/assistant-git-boundary"
private_key_type="$(printf '%s %s' PRIVATE KEY)"

run_assistant_git_boundary() {
  env \
    -u SSH_AUTH_SOCK \
    -u GIT_CONFIG_GLOBAL \
    -u GIT_CONFIG_SYSTEM \
    -u GIT_CONFIG_NOSYSTEM \
    -u GIT_CONFIG_COUNT \
    HOME="$identity_home" \
    XDG_CONFIG_HOME="$identity_home/.config" \
    GH_CONFIG_DIR="${identity_gh_config_dir:-$identity_home/.config/gh}" \
    GITHUB_APP_INSTALLATION_TOKEN=workload-token-fixture \
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
mkdir -p "$identity_home/.local/libexec/uinaf"
: > "$identity_home/.local/libexec/uinaf/git-ssh-sign-agentless"
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
mkdir -p "$identity_home/custom-gh"
mkdir -p "$identity_home/.config/gh"
printf 'github.com:\n  user: example-human\n' > "$identity_home/.config/gh/hosts.yml"
identity_gh_config_dir="$identity_home/custom-gh"
assert_assistant_git_boundary_rejected "persisted GitHub CLI configuration"

printf 'ok profile aliases, layers, applied dotfiles, workload Git identity, and token transport\n'
