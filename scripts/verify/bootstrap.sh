#!/usr/bin/env bash
set -euo pipefail

profile=""
profile_set=0
desktop_baseline=0
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ghostty_config="$HOME/Library/Application Support/com.mitchellh.ghostty/config"

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"
# shellcheck source=scripts/lib/homebrew.sh
. "$repo_root/scripts/lib/homebrew.sh"
# shellcheck source=scripts/lib/shell-probe.sh
. "$repo_root/scripts/lib/shell-probe.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify/bootstrap.sh [--profile personal-workstation|personal-devbox|workstation|devbox|assistant|service] [--desktop]

Checks the live per-user bootstrap for the selected profile. An existing
~/.config/dotfiles/profile is used when --profile is omitted. --desktop is
valid only with a devbox profile.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      if [ "$#" -eq 0 ]; then
        usage >&2
        exit 2
      fi
      if [ "$profile_set" -eq 1 ]; then
        usage >&2
        exit 2
      fi
      profile="$1"
      profile_set=1
      ;;
    --desktop)
      desktop_baseline=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit 2
      ;;
    *)
      if [ "$profile_set" -eq 1 ]; then
        usage >&2
        exit 2
      fi
      profile="$1"
      profile_set=1
      ;;
  esac
  shift
done

if ! profile="$(dotfiles_resolve_profile "$profile")"; then
  usage >&2
  exit 2
fi

if [ "$desktop_baseline" -eq 1 ] && ! dotfiles_profile_is_devbox "$profile"; then
  printf 'FAILED: --desktop requires a devbox profile\n' >&2
  exit 2
fi

common_cli_checks=(
  "age --version"
  "brew --version"
  "chezmoi --version"
  "gh --version"
  "git --version"
  "mise --version"
  "sops --version"
)

developer_cli_checks=(
  "python --version"
  "uv --version"
  "gh auth status"
  "gh stack --help"
  "bun --version"
  "java -version"
  "codex --version"
  "claude --version"
  "cursor-agent --version"
  "autoreview --version"
  "slopomatic version"
)

human_workstation_cli_checks=(
  "op --version"
)

personal_common_cli_checks=(
  "asc --version"
  "attach --help"
  "crabbox --version"
  "gitcrawl --version"
  "mole --version"
)

personal_workstation_cli_checks=(
  "grok --version"
  "tailscale status --peers=false"
)

devbox_cli_checks=(
  "blacksmith --version"
  "tmux -V"
  "xcodes version"
  "tailscale status --peers=false"
)

assistant_cli_checks=(
  "GH_NO_EXTENSION_UPDATE_NOTIFIER=1 gh app-auth exec --help"
  "qpdf --version"
  "qrencode --version"
)

common_config_paths=(
  "$HOME/.config/dotfiles/profile"
  "$HOME/.config/mise/config.toml"
  "$HOME/.gitconfig"
)

developer_config_paths=(
  "$HOME/.config/git/allowed_signers"
  "$HOME/.codex/config.toml"
  "$HOME/.gitconfig.local"
  "$HOME/.ssh/config"
)

workstation_config_paths=(
  "$ghostty_config"
)

personal_config_paths=(
  "$HOME/.config/zed/settings.json"
  "$HOME/.config/zed/keymap.json"
)

section() {
  printf '\n## %s\n' "$1"
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

run_zsh_check() {
  local command="$1"

  section "$command"
  zsh -lic "$command" || fail "$command"
}

check_mise_tool_owner() {
  local label="$1"
  local command="$2"
  local tool="$3"
  local command_path
  local tool_root

  section "$label ownership"
  command_path="$(zsh -lic "mise which $command")" || fail "$label command path"
  tool_root="$(zsh -lic "mise where $tool")" || fail "$label mise tool root"
  printf '%s\n' "$command_path"
  case "$command_path" in
    "$tool_root"/*)
      ;;
    *)
      fail "$label is not owned by mise tool $tool"
      ;;
  esac
}

check_runtime_versions() {
  local missing
  local node_root
  local npm_prefix
  local npm_global_root
  local npm_exec_node

  if [ "$(dotfiles_profile_runtime_group "$profile")" = "none" ]; then
    return
  fi

  section "mise runtime convergence"
  missing="$(zsh -lic 'mise ls --current --missing --no-header')" || fail "mise runtime convergence"
  [ -z "$missing" ] || fail "mise still reports missing configured tools: $missing"

  run_zsh_check "node --version"
  check_mise_tool_owner "Node" "node" "node"

  if ! dotfiles_profile_is_developer "$profile"; then
    return
  fi

  run_zsh_check "pnpm --version"
  run_zsh_check "npm --version"
  run_zsh_check "playwright-cli --version"
  check_mise_tool_owner "pnpm" "pnpm" "node"
  check_mise_tool_owner "npm" "npm" "node"
  check_mise_tool_owner "Playwright CLI" "playwright-cli" "npm:@playwright/cli"

  section "global Vite+"
  if zsh -lic 'command -v vp >/dev/null 2>&1'; then
    fail "vp is available globally; Vite+ must resolve from each repository"
  fi
  printf 'ok no global vp command\n'

  section "npm isolation"
  node_root="$(zsh -lic 'mise where node')" || fail "mise Node root"
  npm_prefix="$(zsh -lic 'npm config get prefix')" || fail "npm prefix"
  npm_global_root="$(zsh -lic 'npm root --global')" || fail "npm global root"
  npm_exec_node="$(zsh -lic 'npm exec --yes -- node -p process.execPath')" \
    || fail "npm exec child Node"

  [ "$npm_prefix" = "$node_root" ] \
    || fail "npm prefix is $npm_prefix; expected mise Node root $node_root"
  [ "$npm_global_root" = "$node_root/lib/node_modules" ] \
    || fail "npm global root is $npm_global_root; expected $node_root/lib/node_modules"
  [ "$npm_exec_node" = "$node_root/bin/node" ] \
    || fail "npm exec uses $npm_exec_node; expected $node_root/bin/node"
  printf 'ok npm prefix, global root, and child Node stay inside mise Node\n'
}

# Behavior and failure text are mirrored in scripts/verify/mise-path-isolation.sh.
# Keep the PATH-ordering branch ahead of the generic non-zero probe failure.
check_mise_doctor() {
  local label="$1"
  local shell_flags="$2"
  local output
  local probe_status

  section "mise doctor ($label)"
  # Resolve the probe shell before capturing stdout/stderr so a missing zsh
  # diagnostic is not swallowed by command substitution + set -e.
  dotfiles_probe_zsh_bin >/dev/null
  # Probe the target shell startup, not an already-activated caller session.
  if output="$(dotfiles_run_clean_zsh "$shell_flags" 'mise doctor' 2>&1)"; then
    probe_status=0
  else
    probe_status=$?
  fi
  printf '%s\n' "$output"

  # Prefer the PATH-ordering diagnostic even when mise doctor exits non-zero.
  if grep -q 'tool paths are not first in PATH' <<< "$output"; then
    printf '\n## PATH (%s)\n' "$label" >&2
    # shellcheck disable=SC2016 # zsh code evaluated by the probe shell
    dotfiles_run_clean_zsh "$shell_flags" 'print -l ${(s/:/)PATH} | nl -ba | sed -n "1,60p"' >&2 \
      || true
    printf 'FAILED: mise tool paths are not first in PATH (%s)\n' "$label" >&2
    exit 1
  fi
  if [ "$probe_status" -ne 0 ]; then
    printf 'FAILED: mise doctor probe exited non-zero (%s)\n' "$label" >&2
    exit 1
  fi
}

check_no_legacy_tool_versions() {
  section "legacy tool files"
  if [ -e "$HOME/.tool-versions" ] || [ -L "$HOME/.tool-versions" ]; then
    fail "legacy ~/.tool-versions exists; use ~/.config/mise/config.toml or repo-local tool files instead"
  fi
  printf 'ok no ~/.tool-versions\n'
}

check_codex_config() {
  local config="$HOME/.codex/config.toml"

  section "codex config"
  # Only enforce ChatGPT-subscription login. Model, reasoning effort, and
  # feature toggles are personal preference and may drift.
  awk '
    BEGIN { ok_login = 0; in_top = 1 }
    /^[[:space:]]*\[/ { in_top = 0 }
    in_top && $0 == "forced_login_method = \"chatgpt\"" { ok_login = 1 }
    END { exit !ok_login }
  ' "$config" || fail "Codex forced_login_method is not chatgpt in $config"
  printf 'ok Codex forced_login_method=chatgpt\n'
}

check_spotlight_indexing() {
  section "spotlight indexing"
  "$repo_root/scripts/bootstrap/configure-spotlight.sh" --check
}

check_desktop_baseline() {
  if [ "$desktop_baseline" -eq 0 ]; then
    return
  fi

  section "desktop baseline"
  "$repo_root/scripts/bootstrap/configure-desktop.sh" --check
}

check_mise() {
  check_mise_doctor "login interactive" -lic
  check_mise_doctor "interactive" -ic
  if dotfiles_profile_is_developer "$profile"; then
    "$repo_root/scripts/bootstrap/trust-agent-worktrees.sh" --check
  fi
}

check_truecolor_shell() {
  if ! dotfiles_profile_is_developer "$profile"; then
    return
  fi

  section "shell truecolor"
  TERM=xterm-ghostty zsh -ic '[ "$COLORTERM" = truecolor ]' || fail "interactive zsh does not set COLORTERM=truecolor for Ghostty SSH sessions"
  printf 'ok COLORTERM=truecolor\n'
}

check_ghostty_ssh_integration() {
  dotfiles_profile_is_workstation "$profile" || return

  section "Ghostty SSH integration"
  grep -Fqx 'shell-integration-features = ssh-env,ssh-terminfo' "$ghostty_config" ||
    fail "Ghostty SSH environment and terminfo integration are not configured in $ghostty_config"
  printf 'ok Ghostty SSH environment and terminfo integration\n'
}

check_remote_ssh_prompt() {
  if ! dotfiles_profile_is_devbox "$profile"; then
    return
  fi

  section "remote user ssh prompt"
  SSH_CONNECTION="${SSH_CONNECTION:-127.0.0.1 1 127.0.0.1 22}" \
    zsh -ic '[[ "$PROMPT" == *"%n@%m"* ]]' || fail "remote SSH shells do not show user@host in PROMPT"
  printf 'ok remote SSH prompt includes user@host\n'
}

check_cli_tools() {
  local check

  for check in "${common_cli_checks[@]}"; do
    run_zsh_check "$check"
  done

  if dotfiles_profile_is_developer "$profile"; then
    for check in "${developer_cli_checks[@]}"; do
      run_zsh_check "$check"
    done
  fi

  if dotfiles_profile_is_personal "$profile"; then
    for check in "${personal_common_cli_checks[@]}"; do
      run_zsh_check "$check"
    done
  fi
  if dotfiles_profile_is_workstation "$profile"; then
    for check in "${human_workstation_cli_checks[@]}"; do
      run_zsh_check "$check"
    done
  fi
  if dotfiles_profile_has_capability "$profile" zed; then
    for check in "${personal_workstation_cli_checks[@]}"; do
      run_zsh_check "$check"
    done
  fi
  if dotfiles_profile_is_devbox "$profile"; then
    for check in "${devbox_cli_checks[@]}"; do
      run_zsh_check "$check"
    done
  fi
  if dotfiles_profile_has_capability "$profile" githubAppAuth; then
    for check in "${assistant_cli_checks[@]}"; do
      run_zsh_check "$check"
    done
  fi
}

check_brew_bundle() {
  local file

  section "brew bundle checks"
  dotfiles_homebrew_configure_external_capabilities "$repo_root" "$profile" ||
    fail "external Homebrew capability validation failed"
  while IFS= read -r file; do
    dotfiles_homebrew_bundle_check "$repo_root/$file" "$profile" \
      || fail "missing Homebrew dependencies from $file"
  done < <(dotfiles_profile_brewfiles "$profile")
}

check_devbox_homebrew() {
  if ! dotfiles_profile_is_devbox "$profile"; then
    return
  fi

  section "Homebrew doctor"
  HOMEBREW_NO_AUTO_UPDATE=1 brew doctor || fail "Homebrew is not healthy for this devbox identity"
}

check_config_paths() {
  local path

  section "config files"
  for path in "${common_config_paths[@]}"; do
    if [ -e "$path" ]; then
      printf 'ok %s\n' "$path"
    else
      fail "missing $path"
    fi
  done

  if dotfiles_profile_is_developer "$profile"; then
    for path in "${developer_config_paths[@]}"; do
      if [ -e "$path" ]; then
        printf 'ok %s\n' "$path"
      else
        fail "missing $path"
      fi
    done
  fi

  if dotfiles_profile_is_workstation "$profile"; then
    for path in "${workstation_config_paths[@]}"; do
      if [ -e "$path" ]; then
        printf 'ok %s\n' "$path"
      else
        fail "missing $path"
      fi
    done
  fi

  if dotfiles_profile_has_capability "$profile" zed; then
    for path in "${personal_config_paths[@]}"; do
      if [ -e "$path" ]; then
        printf 'ok %s\n' "$path"
      else
        fail "missing $path"
      fi
    done
  fi

  if ! installed_profile="$(dotfiles_read_persisted_profile "$HOME/.config/dotfiles/profile" "$(id -u)")" \
    || [ "$installed_profile" != "$profile" ]; then
    fail "installed profile does not match $profile"
  fi
}

check_workload_git_boundary() {
  if ! dotfiles_profile_is_workload "$profile"; then
    return
  fi

  section "$profile workload Git boundary"
  "$repo_root/scripts/verify/workload-git-boundary.sh" --profile "$profile"
}

check_sops_age_identity() {
  local requirement

  section "SOPS age identity"
  # Profile is already normalized; still handle the helper's tri-state explicitly.
  if dotfiles_profile_requires_sops_identity "$profile"; then
    requirement=0
  else
    requirement=$?
  fi
  case "$requirement" in
    0)
      "$repo_root/scripts/secrets/configure-sops-age-identity.sh" --check \
        || fail "SOPS age identity"
      ;;
    1)
      printf 'ok not required for profile %s (SOPS CLI remains available)\n' "$profile"
      ;;
    *)
      fail "unsupported profile for SOPS age identity: $profile"
      ;;
  esac
}

check_mise
check_truecolor_shell
check_remote_ssh_prompt
check_runtime_versions
check_devbox_homebrew
check_brew_bundle
check_cli_tools
check_no_legacy_tool_versions
check_config_paths
check_sops_age_identity
check_ghostty_ssh_integration
if dotfiles_profile_is_developer "$profile"; then
  check_codex_config
  check_spotlight_indexing
fi
check_workload_git_boundary
check_desktop_baseline

printf '\nbootstrap verification ok (%s)\n' "$profile"
