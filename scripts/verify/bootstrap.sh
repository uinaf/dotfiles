#!/usr/bin/env bash
set -euo pipefail

profile=""
profile_set=0
desktop_baseline=0
verbose=0
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
  scripts/verify/bootstrap.sh [--profile personal-workstation|personal-devbox|workstation|devbox|assistant] [--desktop] [--verbose]

Checks the live per-user bootstrap for the selected profile. An existing
~/.config/dotfiles/profile is used when --profile is omitted. --desktop is
valid only with a devbox profile.

Successful check details are hidden by default. Use --verbose to print them.
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
    --verbose)
      verbose=1
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
  "slopguard version"
  "slopmachine version"
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
  "pi --version"
)

personal_workstation_cli_checks=(
  "grok --version"
  "tailscale status --peers=false"
)

devbox_cli_checks=(
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
  run_zsh_check "ruby --version"
  check_mise_tool_owner "pnpm" "pnpm" "node"
  check_mise_tool_owner "npm" "npm" "node"
  check_mise_tool_owner "Playwright CLI" "playwright-cli" "npm:@playwright/cli"
  check_mise_tool_owner "Ruby" "ruby" "ruby"

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

check_mise_doctor() {
  local label="$1"
  local shell_flags="$2"

  section "mise doctor ($label)"
  dotfiles_check_mise_doctor "$label" "$shell_flags"
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
  # Login selection is machine-local. Model, reasoning effort, and feature
  # toggles are personal preference and may drift.
  if awk '
    BEGIN { forced_login = 0; in_top = 1 }
    /^[[:space:]]*\[/ { in_top = 0 }
    in_top && $0 ~ /^[[:space:]]*forced_login_method[[:space:]]*=/ { forced_login = 1 }
    END { exit !forced_login }
  ' "$config"; then
    fail "Codex forced_login_method must be absent from $config"
  fi
  printf 'ok Codex forced_login_method is absent\n'
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
  if ! dotfiles_profile_is_workstation "$profile"; then
    return 0
  fi

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

run_tool_checks() {
  local check

  for check in "$@"; do
    run_zsh_check "$check"
  done
}

check_common_tools() {
  run_tool_checks "${common_cli_checks[@]}"
}

check_developer_tools() {
  run_tool_checks "${developer_cli_checks[@]}"
}

check_android_tools() {
  local android_home
  local command_path
  local command_name
  local relative_path

  section "Android SDK shell environment"
  android_home="$(zsh -lic 'printf %s "$ANDROID_HOME"')" \
    || fail "ANDROID_HOME resolution"
  [ -n "$android_home" ] || fail "ANDROID_HOME is unset"
  [ -d "$android_home" ] || fail "ANDROID_HOME does not exist: $android_home"

  while IFS='|' read -r command_name relative_path; do
    command_path="$(zsh -lic "command -v $command_name")" \
      || fail "$command_name is unavailable"
    [ "$command_path" = "$android_home/$relative_path" ] \
      || fail "$command_name resolves to $command_path; expected $android_home/$relative_path"
    printf 'ok %s resolves from %s\n' "$command_name" "$android_home"
  done <<'TOOLS'
adb|platform-tools/adb
emulator|emulator/emulator
sdkmanager|cmdline-tools/latest/bin/sdkmanager
TOOLS

  run_zsh_check "adb version"
  run_zsh_check "emulator -list-avds"
  run_zsh_check "sdkmanager --version"
}

check_personal_tools() {
  run_tool_checks "${personal_common_cli_checks[@]}"
}

check_workstation_tools() {
  run_tool_checks "${human_workstation_cli_checks[@]}"
}

check_personal_workstation_tools() {
  run_tool_checks "${personal_workstation_cli_checks[@]}"
}

check_devbox_tools() {
  run_tool_checks "${devbox_cli_checks[@]}"
}

check_assistant_tools() {
  run_tool_checks "${assistant_cli_checks[@]}"
}

check_brew_bundle() {
  local file
  local drift

  section "brew bundle checks"
  dotfiles_homebrew_configure_external_capabilities "$repo_root" "$profile" ||
    fail "external Homebrew capability validation failed"
  while IFS= read -r file; do
    dotfiles_homebrew_bundle_check "$repo_root/$file" "$profile" \
      || fail "missing Homebrew dependencies from $file"
  done < <(dotfiles_profile_brewfiles "$profile")

  section "brew bundle drift"
  if drift="$(dotfiles_homebrew_bundle_drift "$repo_root" "$profile")"; then
    printf 'ok no installed packages outside the profile manifests\n'
  else
    printf '%s\n' "$drift"
    fail "installed Homebrew packages drift from the profile manifests; run scripts/bootstrap/brew-bundle.sh --cleanup $profile"
  fi
}

check_devbox_homebrew() {
  local prefix
  local prefix_owner_uid

  if ! dotfiles_profile_is_devbox "$profile"; then
    return
  fi

  section "Homebrew prefix permissions"
  dotfiles_homebrew_verify_prefix_permissions \
    || fail "Homebrew prefix ownership or permissions drifted"
  printf 'ok prefix-owner writes and group read-only access\n'

  section "Homebrew doctor"
  prefix="$(brew --prefix)" || fail "cannot resolve the Homebrew prefix"
  prefix_owner_uid="$(dotfiles_homebrew_path_uid "$prefix")" \
    || fail "cannot read the Homebrew prefix owner"
  if [ "$prefix_owner_uid" != "$(id -u)" ]; then
    printf 'ok skipped write-oriented checks for a read-only Homebrew consumer\n'
    return
  fi
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

check_environment() {
  check_mise
  check_truecolor_shell
  check_remote_ssh_prompt
  check_ghostty_ssh_integration
}

check_runtime() {
  check_runtime_versions
}

check_homebrew() {
  check_devbox_homebrew
  check_brew_bundle
}

check_configuration() {
  check_no_legacy_tool_versions
  check_config_paths
  check_sops_age_identity
  if dotfiles_profile_is_developer "$profile"; then
    check_codex_config
  fi
}

check_host() {
  if dotfiles_profile_is_developer "$profile"; then
    check_spotlight_indexing
  fi
  check_desktop_baseline
}

check_workload() {
  check_workload_git_boundary
}

run_checks() {
  local run_dir
  local started="$SECONDS"
  local failed=0
  local index
  local name
  local command
  local log
  local -a pids=()
  local -a groups=(environment runtime common_tools homebrew configuration)

  if dotfiles_profile_is_developer "$profile"; then
    groups+=(developer_tools android_tools)
  fi
  if dotfiles_profile_is_personal "$profile"; then
    groups+=(personal_tools)
  fi
  if dotfiles_profile_is_workstation "$profile"; then
    groups+=(workstation_tools)
  fi
  if dotfiles_profile_is_personal "$profile" && dotfiles_profile_is_workstation "$profile"; then
    groups+=(personal_workstation_tools)
  fi
  if dotfiles_profile_is_devbox "$profile"; then
    groups+=(devbox_tools)
  fi
  if dotfiles_profile_has_capability "$profile" githubAppAuth; then
    groups+=(assistant_tools)
  fi

  if dotfiles_profile_is_developer "$profile" || [ "$desktop_baseline" -eq 1 ]; then
    groups+=(host)
  fi
  if dotfiles_profile_is_workload "$profile"; then
    groups+=(workload)
  fi

  run_dir="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-bootstrap.XXXXXX")"
  for name in "${groups[@]}"; do
    command="check_$name"
    log="$run_dir/$name.log"
    ("$command") >"$log" 2>&1 &
    pids+=("$!")
  done

  for index in "${!pids[@]}"; do
    name="${groups[$index]}"
    log="$run_dir/$name.log"
    if wait "${pids[$index]}"; then
      if [ "$verbose" -eq 1 ]; then
        cat "$log"
      fi
      printf 'ok %s\n' "${name//_/-}"
    else
      failed=1
      printf '\n## %s\n' "${name//_/-}" >&2
      cat "$log" >&2
      printf 'FAILED: %s\n' "${name//_/-}" >&2
    fi
  done

  for name in "${groups[@]}"; do
    rm -f "$run_dir/$name.log"
  done
  rmdir "$run_dir"

  [ "$failed" -eq 0 ] || exit 1
  printf 'bootstrap verification ok (%s, %ss)\n' "$profile" "$((SECONDS - started))"
}

run_checks
