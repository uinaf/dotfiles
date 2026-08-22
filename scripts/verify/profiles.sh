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

managed_paths() {
  local profile="$1"
  local home="$tmp_root/managed-$profile"
  local data

  mkdir -p "$home"
  data="$(printf '{"dotfilesProfile":"%s"}' "$profile")"
  chezmoi \
    --source "$repo_root/chezmoi" \
    --destination "$home" \
    --override-data "$data" \
    managed --path-style relative
}

assert_eq personal-workstation "$(dotfiles_normalize_profile personal-workstation)" "personal workstation profile"
assert_eq personal-devbox "$(dotfiles_normalize_profile personal-devbox)" "personal devbox profile"
assert_eq workstation "$(dotfiles_normalize_profile workstation)" "workstation profile"
assert_eq devbox "$(dotfiles_normalize_profile devbox)" "devbox profile"
assert_eq assistant "$(dotfiles_normalize_profile assistant)" "assistant profile"
if dotfiles_normalize_profile unsupported >/dev/null 2>&1; then
  fail "unsupported profile was accepted"
fi
if dotfiles_normalize_profile personal >/dev/null 2>&1; then
  fail "retired personal profile was accepted"
fi
if "$repo_root/scripts/bootstrap/configure-power.sh" workstation devbox >/dev/null 2>&1; then
  fail "configure-power accepted duplicate profile arguments"
fi
if "$repo_root/scripts/verify/bootstrap.sh" workstation devbox >/dev/null 2>&1; then
  fail "bootstrap verification accepted duplicate profile arguments"
fi

for supported_profile in $(dotfiles_profiles); do
  for predicate in \
    dotfiles_profile_is_developer \
    dotfiles_profile_is_workload \
    dotfiles_profile_uses_shared_brew \
    dotfiles_profile_requires_sops_identity \
    dotfiles_profile_is_devbox; do
    if "$predicate" "$supported_profile"; then
      predicate_status=0
    else
      predicate_status=$?
    fi
    [ "$predicate_status" -le 1 ] \
      || fail "$predicate returned unsupported for supported profile $supported_profile"
  done
done

if ! dotfiles_profile_requires_sops_identity personal-workstation \
  || ! dotfiles_profile_requires_sops_identity personal-devbox \
  || ! dotfiles_profile_requires_sops_identity devbox \
  || ! dotfiles_profile_requires_sops_identity assistant; then
  fail "secret-consuming profiles must require a SOPS age identity"
fi
if dotfiles_profile_requires_sops_identity workstation; then
  fail "portable profiles must not require a SOPS age identity"
fi
if dotfiles_profile_requires_sops_identity unsupported >/dev/null 2>&1; then
  sops_identity_status=0
else
  sops_identity_status=$?
fi
if [ "$sops_identity_status" -ne 2 ]; then
  fail "unsupported profile must return status 2 from SOPS identity helper (got $sops_identity_status)"
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
printf 'assistant' > "$profile_home/.config/dotfiles/profile"
assert_eq assistant "$(HOME="$profile_home" dotfiles_resolve_profile)" \
  "unterminated single-record persisted profile"
rm "$profile_home/.config/dotfiles/profile"

agent_sync_home="$tmp_root/agent-sync-profile"
mkdir -p "$agent_sync_home/.config/dotfiles"
printf 'personal-devbox\n' > "$agent_sync_home/.config/dotfiles/profile"
assert_eq personal-devbox "$({
  HOME="$agent_sync_home" \
  DOTFILES_PROFILE=workstation \
  DOTFILES_PROFILE_FILE="$tmp_root/ignored-profile" \
    "$repo_root/scripts/agents/resolve-profile.sh" --expected personal-devbox
})" "agent sync canonical profile"
if HOME="$agent_sync_home" \
  "$repo_root/scripts/agents/resolve-profile.sh" --expected devbox >/dev/null 2>&1; then
  fail "agent sync accepted a mismatched expected profile"
elif [ "$?" -ne 3 ]; then
  fail "agent sync mismatch did not return refusal status"
fi
printf 'assistant\n' > "$agent_sync_home/.config/dotfiles/profile"
if HOME="$agent_sync_home" "$repo_root/scripts/agents/resolve-profile.sh" >/dev/null 2>&1; then
  fail "assistant profile accepted agent sync"
elif [ "$?" -ne 3 ]; then
  fail "assistant agent sync refusal returned the wrong status"
fi

config_home="$tmp_root/config-paths"
mkdir -p "$config_home/.config/dotfiles"
assert_eq "$config_home/.config/dotfiles/devbox.env" \
  "$(HOME="$config_home" dotfiles_resolve_config_file '' devbox.env)" \
  "canonical config default"
printf 'canonical\n' > "$config_home/.config/dotfiles/devbox.env"
assert_eq "$config_home/.config/dotfiles/devbox.env" \
  "$(HOME="$config_home" dotfiles_resolve_config_file '' devbox.env)" \
  "canonical config path"

canonical_symlink_home="$tmp_root/canonical-symlink-directory"
canonical_symlink_target="$tmp_root/canonical-symlink-directory-target"
mkdir -p "$canonical_symlink_home/.config" "$canonical_symlink_target"
ln -s "$canonical_symlink_target" "$canonical_symlink_home/.config/dotfiles"
if HOME="$canonical_symlink_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null 2>&1; then
  fail "dotfiles apply accepted a symlinked canonical config directory"
fi
[ -z "$(find "$canonical_symlink_target" -mindepth 1 -print -quit)" ] \
  || fail "rejected canonical config directory received managed files"

task_home="$tmp_root/task-profile"
mise_global_config="${MISE_GLOBAL_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/mise/config.toml}"
mise_global_config_dir="${MISE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/mise}"
mise_fixture_config_dir="$tmp_root/isolated-mise-config"
mise_ambient_config_home="$tmp_root/ambient-xdg-config"
mise_ignored_config_paths="${MISE_IGNORED_CONFIG_PATHS:+${MISE_IGNORED_CONFIG_PATHS}:}${mise_global_config}:${mise_global_config_dir}"
mkdir -p "$task_home" "$mise_fixture_config_dir" "$mise_ambient_config_home/mise/conf.d"
printf '[env]\nDOTFILES_UNTRUSTED_FIXTURE = "must-not-load"\n' > "$mise_ambient_config_home/mise/conf.d/work.toml"
(
  mise_env_json=""
  cd "$repo_root"
  if ! mise_env_json="$(HOME="$task_home" XDG_CONFIG_HOME="$mise_ambient_config_home" MISE_CONFIG_DIR="$mise_fixture_config_dir" MISE_GLOBAL_CONFIG_FILE="$mise_fixture_config_dir/config.toml" MISE_IGNORED_CONFIG_PATHS="$mise_ignored_config_paths" MISE_TRUSTED_CONFIG_PATHS="$repo_root" \
    mise env --json)"; then
    fail "profile verification could not inspect the isolated mise environment"
  fi
  if printf '%s\n' "$mise_env_json" | grep -q DOTFILES_UNTRUSTED_FIXTURE; then
    fail "profile verification loaded an ignored global mise conf.d fragment"
  fi
  HOME="$task_home" XDG_CONFIG_HOME="$mise_ambient_config_home" MISE_CONFIG_DIR="$mise_fixture_config_dir" MISE_GLOBAL_CONFIG_FILE="$mise_fixture_config_dir/config.toml" MISE_IGNORED_CONFIG_PATHS="$mise_ignored_config_paths" MISE_TRUSTED_CONFIG_PATHS="$repo_root" \
    ./dotfiles diff assistant >/dev/null
  [ ! -e "$task_home/.config/dotfiles/profile" ] \
    || fail "operator diff mutated the disposable home"
  HOME="$task_home" XDG_CONFIG_HOME="$mise_ambient_config_home" MISE_CONFIG_DIR="$mise_fixture_config_dir" MISE_GLOBAL_CONFIG_FILE="$mise_fixture_config_dir/config.toml" MISE_IGNORED_CONFIG_PATHS="$mise_ignored_config_paths" MISE_TRUSTED_CONFIG_PATHS="$repo_root" \
    mise run dotfiles:apply assistant >/dev/null
)
assert_eq assistant "$(sed -n '1p' "$task_home/.config/dotfiles/profile")" \
  "dotfiles task profile forwarding"

assistant_files="$(dotfiles_profile_brewfiles assistant)"
assert_eq "$(printf 'Brewfile\nBrewfile.assistant')" "$assistant_files" "assistant Brewfile layers"
devbox_files="$(dotfiles_profile_brewfiles devbox)"
assert_eq "$(printf 'Brewfile\nBrewfile.developer\nBrewfile.devbox')" "$devbox_files" "devbox Brewfile layers"
personal_devbox_files="$(dotfiles_profile_brewfiles personal-devbox)"
assert_eq "$(printf 'Brewfile\nBrewfile.developer\nBrewfile.devbox\nBrewfile.personal')" "$personal_devbox_files" "personal devbox Brewfile layers"
workstation_files="$(dotfiles_profile_brewfiles workstation)"
assert_eq "$(printf 'Brewfile\nBrewfile.developer\nBrewfile.workstation')" "$workstation_files" "workstation Brewfile layers"
personal_workstation_files="$(dotfiles_profile_brewfiles personal-workstation)"
assert_eq "$(printf 'Brewfile\nBrewfile.developer\nBrewfile.workstation\nBrewfile.personal')" "$personal_workstation_files" "personal workstation Brewfile layers"
if unsupported_files="$(dotfiles_profile_brewfiles unsupported 2>/dev/null)"; then
  fail "unsupported profile resolved Brewfile layers"
fi
[ -z "$unsupported_files" ] || fail "unsupported profile emitted partial Brewfile layers"

personal_workstation_casks="$(
  HOMEBREW_BUNDLE_DOTFILES_PROFILE=personal-workstation HOMEBREW_NO_AUTO_UPDATE=1 \
    brew bundle list --cask --file "$repo_root/Brewfile.personal"
)"
printf '%s\n' "$personal_workstation_casks" | grep -Fqx tailscale-app \
  || fail "personal workstation Brewfile omitted tailscale-app"
printf '%s\n' "$personal_workstation_casks" | grep -Fqx slopwake \
  || fail "personal workstation Brewfile omitted slopwake"
personal_devbox_casks="$(
  HOMEBREW_BUNDLE_DOTFILES_PROFILE=personal-devbox HOMEBREW_NO_AUTO_UPDATE=1 \
    brew bundle list --cask --file "$repo_root/Brewfile.personal"
)"
[ -z "$personal_devbox_casks" ] \
  || fail "personal devbox Brewfile included headful casks: $personal_devbox_casks"
personal_workstation_formulae="$(
  HOMEBREW_BUNDLE_DOTFILES_PROFILE=personal-workstation HOMEBREW_NO_AUTO_UPDATE=1 \
    brew bundle list --formula --file "$repo_root/Brewfile.personal"
)"
printf '%s\n' "$personal_workstation_formulae" | grep -Fqx mas \
  || fail "personal workstation Brewfile omitted mas"
personal_devbox_formulae="$(
  HOMEBREW_BUNDLE_DOTFILES_PROFILE=personal-devbox HOMEBREW_NO_AUTO_UPDATE=1 \
    brew bundle list --formula --file "$repo_root/Brewfile.personal"
)"
if printf '%s\n' "$personal_devbox_formulae" | grep -Fqx mas; then
  fail "personal devbox Brewfile included workstation-only mas"
fi
if personal_error="$(
  HOMEBREW_BUNDLE_DOTFILES_PROFILE=workstation HOMEBREW_NO_AUTO_UPDATE=1 \
    brew bundle list --all --file "$repo_root/Brewfile.personal" 2>&1
)"; then
  fail "personal Brewfile accepted a non-personal profile"
fi
printf '%s\n' "$personal_error" | grep -Fq \
  'Brewfile.personal requires a personal-workstation or personal-devbox profile' \
  || fail "personal Brewfile profile failure was not actionable"

for required in 'cask "codex"' 'cask "claude-code@latest"' 'cask "uinaf/tap/slopguard"' 'cask "uinaf/tap/slopmachine"'; do
  grep -Fqx "$required" "$repo_root/Brewfile.developer" \
    || fail "developer layer missed $required"
  for file in Brewfile.workstation Brewfile.personal Brewfile.devbox; do
    if grep -Fqx "$required" "$repo_root/$file"; then
      fail "$file duplicates shared developer dependency $required"
    fi
  done
done
for required in 'brew "awscli"' 'brew "docker-credential-helper"' 'brew "opencode"' 'brew "xcodegen"' 'cask "android-commandlinetools"'; do
  grep -Fqx "$required" "$repo_root/Brewfile.developer" \
    || fail "developer layer missed $required"
  for file in Brewfile.workstation Brewfile.personal Brewfile.devbox Brewfile.assistant; do
    if grep -Fqx "$required" "$repo_root/$file"; then
      fail "$file duplicates developer dependency $required"
    fi
  done
done
grep -Fqx 'brew "watchman"' "$repo_root/Brewfile.developer" \
  || fail "developer layer missed Watchman"
for file in Brewfile.workstation Brewfile.personal Brewfile.devbox Brewfile.assistant; do
  if grep -Fqx 'brew "watchman"' "$repo_root/$file"; then
    fail "$file duplicates developer Watchman"
  fi
done
for required in 'brew "asc"' 'brew "uinaf/tap/attach"' 'brew "openclaw/tap/crabbox"' 'brew "openclaw/tap/discrawl"' 'brew "openclaw/tap/gitcrawl"' 'brew "putdotio/tap/putio-cli"' 'brew "mole"' 'brew "pi-coding-agent"'; do
  grep -Fqx "$required" "$repo_root/Brewfile.personal" \
    || fail "personal layer missed $required"
  for file in Brewfile.developer Brewfile.workstation Brewfile.devbox Brewfile.assistant; do
    if grep -Fqx "$required" "$repo_root/$file"; then
      fail "$file includes personal dependency $required"
    fi
  done
done
grep -Fqx 'tap "putdotio/tap"' "$repo_root/Brewfile.personal" \
  || fail "personal layer missed putdotio/tap"
grep -Fqx 'tap "uinaf/tap"' "$repo_root/Brewfile.developer" \
    || fail "developer layer missed the shared uinaf/tap"
for file in Brewfile.workstation Brewfile.personal Brewfile.devbox; do
  if grep -Fqx 'tap "uinaf/tap"' "$repo_root/$file"; then
    fail "$file duplicates the shared developer uinaf/tap"
  fi
done
for required in 'brew "gh"' 'cask "google-chrome"'; do
  grep -Fqx "$required" "$repo_root/Brewfile" \
    || fail "base layer missed $required"
  for file in Brewfile.developer Brewfile.workstation Brewfile.personal Brewfile.devbox Brewfile.assistant; do
    if grep -Fqx "$required" "$repo_root/$file"; then
      fail "$file duplicates shared base dependency $required"
    fi
  done
done
for required in 'cask "ghostty"' 'cask "1password"' 'cask "1password-cli"' 'cask "slack"' 'cask "t3-code"' 'cask "zed"' 'brew "ykman"'; do
  grep -Fqx "$required" "$repo_root/Brewfile.workstation" \
    || fail "workstation layer missed shared human desktop app $required"
done
for file in Brewfile.developer Brewfile.personal Brewfile.devbox Brewfile.assistant; do
  for workstation_only in 'cask "ghostty"' 'cask "1password"' 'cask "1password-cli"' 'brew "ykman"'; do
    if grep -Fqx "$workstation_only" "$repo_root/$file"; then
      fail "$file includes workstation-only dependency $workstation_only"
    fi
  done
done
for required in 'brew "yt-dlp"' 'brew "poppler"' 'brew "qpdf"' 'brew "qrencode"' 'brew "weasyprint"' 'brew "whisper-cpp"' 'brew "summarize"' 'brew "openclaw/tap/gogcli"' 'brew "steipete/tap/peekaboo"'; do
  grep -Fqx "$required" "$repo_root/Brewfile.assistant" \
    || fail "assistant layer missed $required"
  if grep -Fqx "$required" "$repo_root/Brewfile.devbox"; then
    fail "devbox layer retained assistant dependency $required"
  fi
done
for removed in 'cask "gcloud-cli"' 'brew "openclaw/tap/crabbox"' 'brew "openclaw/tap/gitcrawl"'; do
  if grep -Fqx "$removed" "$repo_root/Brewfile.devbox"; then
    fail "devbox layer retained $removed"
  fi
done
for file in Brewfile Brewfile.developer Brewfile.workstation Brewfile.personal Brewfile.devbox Brewfile.assistant; do
  for removed_cask in 'cask "chatgpt"' 'cask "cursor"'; do
    if grep -Fqx "$removed_cask" "$repo_root/$file"; then
      fail "$file retained removed cask $removed_cask"
    fi
  done
done
printf '%s\n' "$personal_workstation_casks" | grep -Fqx grok-build \
  || fail "personal workstation layer missed Grok Build"
for file in Brewfile Brewfile.developer Brewfile.workstation Brewfile.devbox Brewfile.assistant; do
  if grep -Fqx 'cask "grok-build"' "$repo_root/$file"; then
    fail "$file includes personal-only Grok Build"
  fi
done

assistant_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile assistant)"
assert_eq "$(printf 'apply-dotfiles\ninstall-runtimes\ninstall-gh-app-auth')" "$assistant_steps" "assistant install steps"
developer_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile workstation)"
for step in apply-dotfiles install-runtimes install-cursor-agent trust-agent-worktrees install-gh-extensions configure-codex sync-agents; do
  printf '%s\n' "$developer_steps" | grep -Fqx "$step" || fail "workstation install missed $step"
done
devbox_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile devbox)"
assert_eq "$developer_steps" "$devbox_steps" "devbox developer install steps"
personal_devbox_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile personal-devbox)"
printf '%s\n' "$personal_devbox_steps" | grep -Fqx configure-llm-gateway \
  || fail "personal devbox install missed configure-llm-gateway"
personal_workstation_steps="$("$repo_root/scripts/bootstrap/install.sh" --print-steps --profile personal-workstation)"
printf '%s\n' "$personal_workstation_steps" | grep -Fqx configure-llm-gateway \
  || fail "personal workstation install missed configure-llm-gateway"
for personal_steps in "$personal_devbox_steps" "$personal_workstation_steps"; do
  assert_eq 1 "$(comm -13 <(printf '%s\n' "$developer_steps" | sort) <(printf '%s\n' "$personal_steps" | sort) | grep -Fxc configure-llm-gateway)" \
    "personal install adds only the gateway convergence step"
done

install_fixture="$tmp_root/install-fixture"
install_log="$tmp_root/install-fixture.log"
install_fixture_path="$install_fixture/bin:$PATH"
mkdir -p "$install_fixture/scripts/agents" "$install_fixture/scripts/bootstrap" "$install_fixture/scripts/lib" \
  "$install_fixture/chezmoi/.chezmoidata" "$install_fixture/bin"
cp "$repo_root/scripts/bootstrap/install.sh" "$install_fixture/scripts/bootstrap/install.sh"
cp "$repo_root/scripts/lib/profile.sh" "$install_fixture/scripts/lib/profile.sh"
cp "$repo_root/chezmoi/.chezmoidata/profiles.json" "$install_fixture/chezmoi/.chezmoidata/profiles.json"
for helper in apply-dotfiles.sh install-gh-app-auth.sh install-cursor-agent.sh trust-agent-worktrees.sh install-gh-extensions.sh configure-codex.ts configure-llm-gateway.ts; do
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
for agent_script in sync.ts plugins.ts mcps.ts; do
cat > "$install_fixture/scripts/agents/$agent_script" <<'EOF'
#!/usr/bin/env bash
printf '%s' "$(basename "$0")" >> "${DOTFILES_INSTALL_LOG:?}"
[ "$#" -eq 0 ] || printf ' %s' "$@" >> "${DOTFILES_INSTALL_LOG:?}"
printf '\n' >> "${DOTFILES_INSTALL_LOG:?}"
EOF
  chmod 0700 "$install_fixture/scripts/agents/$agent_script"
done
cat > "$install_fixture/bin/mise" <<'EOF'
#!/usr/bin/env bash
printf '%s' "$(basename "$0")" >> "${DOTFILES_INSTALL_LOG:?}"
[ "$#" -eq 0 ] || printf ' %s' "$@" >> "${DOTFILES_INSTALL_LOG:?}"
printf '\n' >> "${DOTFILES_INSTALL_LOG:?}"
EOF
chmod 0700 "$install_fixture/bin/mise"

: > "$install_log"
PATH="$install_fixture_path" \
DOTFILES_INSTALL_LOG="$install_log" \
HOME="$tmp_root/install-assistant-home" \
  "$install_fixture/scripts/bootstrap/install.sh" --profile assistant
assert_eq "$(printf 'apply-dotfiles.sh --profile assistant\nmise install\ninstall-gh-app-auth.sh')" "$(cat "$install_log")" \
  "assistant install execution"

: > "$install_log"
install_devbox_home="$tmp_root/install-devbox-home"
PATH="$install_fixture_path" \
DOTFILES_INSTALL_LOG="$install_log" \
HOME="$install_devbox_home" \
  "$install_fixture/scripts/bootstrap/install.sh" --profile devbox
expected_install_log="$(cat <<EOF
apply-dotfiles.sh --profile devbox
mise install
install-cursor-agent.sh
trust-agent-worktrees.sh
install-gh-extensions.sh
configure-codex.ts
sync.ts --profile devbox
plugins.ts --profile devbox
mcps.ts --profile devbox
EOF
)"
assert_eq "$expected_install_log" "$(cat "$install_log")" "devbox install execution"

: > "$install_log"
install_personal_home="$tmp_root/install-personal-home"
mkdir -p "$install_personal_home/.config/dotfiles"
printf '{}\n' > "$install_personal_home/.config/dotfiles/llm-gateway.json"
chmod 0600 "$install_personal_home/.config/dotfiles/llm-gateway.json"
PATH="$install_fixture_path" \
DOTFILES_INSTALL_LOG="$install_log" \
HOME="$install_personal_home" \
  "$install_fixture/scripts/bootstrap/install.sh" --profile personal-workstation
expected_personal_install_log="$(cat <<EOF
apply-dotfiles.sh --profile personal-workstation
mise install
install-cursor-agent.sh
trust-agent-worktrees.sh
install-gh-extensions.sh
configure-codex.ts
configure-llm-gateway.ts
configure-llm-gateway.ts --retire-auth
sync.ts --profile personal-workstation
plugins.ts --profile personal-workstation
mcps.ts --profile personal-workstation
EOF
)"
assert_eq "$expected_personal_install_log" "$(cat "$install_log")" "personal workstation install execution"

: > "$install_log"
printf 'caller-input\n' | \
  PATH="$install_fixture_path" \
  DOTFILES_INSTALL_LOG="$install_log" \
  DOTFILES_INSTALL_READ_STDIN=apply-dotfiles.sh \
  HOME="$tmp_root/install-stdin-home" \
    "$install_fixture/scripts/bootstrap/install.sh" --profile assistant
assert_eq "$(printf 'apply-dotfiles.sh --profile assistant\nstdin caller-input\nmise install\ninstall-gh-app-auth.sh')" \
  "$(cat "$install_log")" \
  "install step caller stdin"

assert_install_rejected() {
  local label="$1"
  shift

  if PATH="$install_fixture_path" \
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
printf '%s\n' "$assistant_mise" | grep -Fqx 'node = "24.19.0"' \
  || fail 'assistant mise config missed the pinned Node runtime'
for rejected in 'python =' 'uv =' 'bun =' 'java =' 'ruby =' 'go =' 'playwright' 'vite-plus' 'trusted_config_paths' 'pnpm@'; do
  if printf '%s\n' "$assistant_mise" | grep -Fq "$rejected"; then
    fail "assistant mise config included developer setting $rejected"
  fi
done

workstation_mise="$(render_target workstation .config/mise/config.toml)"
for expected in 'node = { version = "24.19.0"' 'npm@12.0.2' 'pnpm@11.22.0' 'bun = "1.4.0"' 'java = "temurin-21"' 'ruby = "4.0.6"' 'go = "1.26.6"' '"npm:@playwright/cli" = "0.1.18"' 'trusted_config_paths'; do
  printf '%s\n' "$workstation_mise" | grep -Fq "$expected" || fail "workstation mise config missed $expected"
done
for rejected in 'pnpm@12.0.0-beta.2' 'npm:vite-plus'; do
  if printf '%s\n' "$workstation_mise" | grep -Fq "$rejected"; then
    fail "workstation mise config included retired tooling $rejected"
  fi
done

devbox_mise="$(render_target devbox .config/mise/config.toml)"
assert_eq "$workstation_mise" "$devbox_mise" "devbox developer mise config"
personal_devbox_mise="$(render_target personal-devbox .config/mise/config.toml)"
assert_eq "$devbox_mise" "$personal_devbox_mise" "personal devbox mise config"
personal_workstation_mise="$(render_target personal-workstation .config/mise/config.toml)"
assert_eq "$workstation_mise" "$personal_workstation_mise" "personal workstation developer mise config"

assert_eq assistant "$(render_target assistant .config/dotfiles/profile)" "rendered assistant profile"
assert_eq personal-workstation "$(render_target personal-workstation .config/dotfiles/profile)" "rendered personal workstation profile"
assert_eq personal-devbox "$(render_target personal-devbox .config/dotfiles/profile)" "rendered personal devbox profile"

for profile in workstation personal-workstation personal-devbox devbox assistant; do
  profile_zshrc="$(render_target "$profile" .zshrc)"
  for variable in EDITOR VISUAL; do
    printf '%s\n' "$profile_zshrc" | grep -Fqx "export $variable=\"vim\"" \
      || fail "$profile zshrc missed vim $variable"
  done
  if printf '%s\n' "$profile_zshrc" | grep -Eq 'zed --wait'; then
    fail "$profile zshrc selected Zed"
  fi
done

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
  '.gitconfig' \
  '.local/libexec/dotfiles/git-ssh-sign-agentless' \
  '.ssh/config' \
  '.config/zed/keymap.json' \
  '.config/zed/settings.json' \
  'Library/Application Support/com.mitchellh.ghostty/config'; do
  printf '%s\n' "$workstation_managed" | grep -Fqx "$required_path" \
    || fail "workstation profile does not manage $required_path"
done
personal_workstation_managed="$({
  data='{"dotfilesProfile":"personal-workstation"}'
  chezmoi \
    --source "$repo_root/chezmoi" \
    --destination "$tmp_root/personal-workstation" \
    --override-data "$data" \
    managed --path-style relative
})"
for required_path in '.config/zed/keymap.json' '.config/zed/settings.json'; do
  printf '%s\n' "$personal_workstation_managed" | grep -Fqx "$required_path" \
    || fail "personal workstation profile does not manage $required_path"
done
devbox_managed="$({
  data='{"dotfilesProfile":"devbox"}'
  chezmoi \
    --source "$repo_root/chezmoi" \
    --destination "$tmp_root/devbox" \
    --override-data "$data" \
    managed --path-style relative
})"
personal_devbox_managed="$(managed_paths personal-devbox)"
if printf '%s\n' "$personal_devbox_managed" | grep -Eq '^Library/Application Support/com\.mitchellh\.ghostty(/|$)'; then
  fail "personal devbox profile manages headful application state"
fi
for required_path in \
  '.config/git/allowed_signers' \
  '.gitconfig' \
  '.local/libexec/dotfiles/git-ssh-sign-agentless' \
  '.ssh/config'; do
  printf '%s\n' "$devbox_managed" | grep -Fqx "$required_path" \
    || fail "devbox profile does not manage $required_path"
done
if printf '%s\n' "$devbox_managed" | grep -Eq '^Library/Application Support/com\.mitchellh\.ghostty(/|$)'; then
  fail "devbox profile manages workstation-only Ghostty state"
fi
for rendered_unmanaged in \
  "$assistant_managed" \
  "$personal_devbox_managed" \
  "$devbox_managed"; do
  if printf '%s\n' "$rendered_unmanaged" | grep -Eq '^\.config/zed(/|$)'; then
    fail "non-workstation profile manages Zed state"
  fi
done

assistant_home="$tmp_root/assistant-applied"
mkdir -p "$assistant_home"
HOME="$assistant_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null
assert_eq assistant "$(sed -n '1p' "$assistant_home/.config/dotfiles/profile")" "applied assistant profile"

preservation_home="$tmp_root/assistant-preserves-developer-state"
mkdir -p \
  "$preservation_home/.config/1Password/ssh" \
  "$preservation_home/.codex/browser"
ln -s "$tmp_root/external/agent.toml" \
  "$preservation_home/.config/1Password/ssh/agent.toml"
ln -s "$tmp_root/external/codex.toml" "$preservation_home/.codex/config.toml"
ln -s "$tmp_root/external/browser.toml" \
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
printf '%s\n' "$assistant_gitconfig" | grep -Fqx $'\tpath = ~/.config/dotfiles/github-app.gitconfig' \
  || fail "assistant Git base config missed optional GitHub App include"
if printf '%s\n' "$assistant_gitconfig" | grep -Eq '^\[(credential|gpg)|gh auth git-credential|signing'; then
  fail "assistant Git base config included developer authentication or signing settings"
fi
identity_home="$tmp_root/assistant-git-boundary"

mkdir -p "$identity_home"
HOME="$identity_home" "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile assistant >/dev/null
HOME="$identity_home" \
GIT_USER_NAME='Example Workload' \
GIT_USER_EMAIL='example-workload@users.noreply.github.com' \
  "$repo_root/scripts/bootstrap/configure-git.sh" --profile assistant --non-interactive >/dev/null
HOME="$identity_home" "$repo_root/scripts/verify/assistant-git-boundary.sh" >/dev/null

printf 'ok profile layers, applied dotfiles, and workload Git identity\n'
