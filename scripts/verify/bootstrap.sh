#!/usr/bin/env bash
set -euo pipefail

profile="personal"
desktop_baseline=0
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify/bootstrap.sh [--profile personal|devbox] [--desktop]

Checks the live machine bootstrap for the selected profile. The default profile
is personal for backward compatibility. --desktop adds the owner-only devbox
desktop baseline and is valid only with --profile devbox.
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
      profile="$1"
      ;;
    personal|devbox)
      profile="$1"
      ;;
    --desktop)
      desktop_baseline=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$profile" in
  personal|devbox)
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [ "$desktop_baseline" -eq 1 ] && [ "$profile" != "devbox" ]; then
  printf 'FAILED: --desktop requires --profile devbox\n' >&2
  exit 2
fi

common_cli_checks=(
  "brew --version"
  "chezmoi --version"
  "git --version"
  "gh auth status"
  "mise --version"
  "bun --version"
  "python --version"
  "java -version"
  "uv --version"
  "infisical --version"
  "codex --version"
  "cursor-agent --version"
  "gitcrawl --version"
  "tailscale status --peers=false"
)

personal_cli_checks=(
  "op --version"
  "blacksmith --version"
)

devbox_cli_checks=(
  "process-compose version"
  "tmux -V"
  "qpdf --version"
  "qrencode --version"
  "xcodes version"
)

common_config_paths=(
  "$HOME/.config/zed/settings.json"
  "$HOME/.config/zed/keymap.json"
  "$HOME/.codex/config.toml"
  "$HOME/Library/Application Support/com.mitchellh.ghostty/config"
  "$HOME/.gitconfig"
  "$HOME/.gitconfig.local"
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

check_exact_version() {
  local label="$1"
  local expected="$2"
  local command="$3"
  local actual

  section "$label version"
  actual="$(zsh -lic "$command")" || fail "$label version"
  printf '%s\n' "$actual"
  if [ "$actual" != "$expected" ]; then
    fail "$label version is $actual; expected $expected"
  fi
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

check_node_tool_versions() {
  local node_root
  local npm_prefix
  local npm_global_root
  local npm_exec_node

  check_exact_version "Node" "v24.18.0" "node --version"
  check_exact_version "Corepack" "0.35.0" "corepack --version"
  check_exact_version "pnpm" "11.15.0" "pnpm --version"
  check_exact_version "npm" "12.0.1" "npm --version"
  check_exact_version "Playwright CLI" "0.1.17" "playwright-cli --version"
  check_exact_version "Vite+" "vp v0.2.5" "vp --version 2>/dev/null | head -n 1"
  check_mise_tool_owner "Corepack" "corepack" "node"
  check_mise_tool_owner "pnpm" "pnpm" "node"
  check_mise_tool_owner "npm" "npm" "node"
  check_mise_tool_owner "Playwright CLI" "playwright-cli" "npm:@playwright/cli"
  check_mise_tool_owner "Vite+" "vp" "npm:vite-plus"

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
  local output

  section "mise doctor ($label)"
  output="$(zsh "$shell_flags" 'mise doctor' 2>&1)"
  printf '%s\n' "$output"

  if grep -q 'tool paths are not first in PATH' <<< "$output"; then
    printf '\n## PATH (%s)\n' "$label" >&2
    zsh "$shell_flags" 'print -l ${(s/:/)PATH} | nl -ba | sed -n "1,60p"' >&2
    printf 'FAILED: mise tool paths are not first in PATH (%s)\n' "$label" >&2
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
  awk '
    BEGIN { ok_model = ok_reasoning = ok_login = ok_goals = ok_memories = 0; in_top = 1; in_features = 0 }
    /^[[:space:]]*\[/ { in_top = 0; in_features = ($0 == "[features]") }
    in_top && $0 == "model = \"gpt-5.6-sol\"" { ok_model = 1 }
    in_top && $0 == "model_reasoning_effort = \"high\"" { ok_reasoning = 1 }
    in_top && $0 == "forced_login_method = \"chatgpt\"" { ok_login = 1 }
    in_features && $0 == "goals = true" { ok_goals = 1 }
    in_features && $0 == "memories = true" { ok_memories = 1 }
    END { exit !(ok_model && ok_reasoning && ok_login && ok_goals && ok_memories) }
  ' "$config" || fail "Codex defaults are not configured in $config"
  printf 'ok Codex model/login/features defaults\n'
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
  "$repo_root/scripts/bootstrap/trust-agent-worktrees.sh" --check
}

check_truecolor_shell() {
  section "shell truecolor"
  TERM=xterm-ghostty zsh -ic '[ "$COLORTERM" = truecolor ]' || fail "interactive zsh does not set COLORTERM=truecolor for Ghostty SSH sessions"
  printf 'ok COLORTERM=truecolor\n'
}

check_devbox_ssh_prompt() {
  if [ "$profile" != "devbox" ]; then
    return
  fi

  section "devbox ssh prompt"
  SSH_CONNECTION="${SSH_CONNECTION:-127.0.0.1 1 127.0.0.1 22}" \
    zsh -ic '[[ "$PROMPT" == *"%n@%m"* ]]' || fail "devbox SSH shells do not show user@host in PROMPT"
  printf 'ok devbox SSH prompt includes user@host\n'
}

check_cli_tools() {
  local check

  for check in "${common_cli_checks[@]}"; do
    run_zsh_check "$check"
  done

  if [ "$profile" = "personal" ]; then
    for check in "${personal_cli_checks[@]}"; do
      run_zsh_check "$check"
    done
  else
    for check in "${devbox_cli_checks[@]}"; do
      run_zsh_check "$check"
    done
  fi
}

check_brew_bundle() {
  local file

  section "brew bundle checks"
  for file in Brewfile "Brewfile.$profile"; do
    brew bundle check --file "$repo_root/$file" || fail "missing Homebrew dependencies from $file"
  done
}

check_devbox_homebrew() {
  if [ "$profile" != "devbox" ]; then
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
}

check_mise
check_truecolor_shell
check_devbox_ssh_prompt
check_node_tool_versions
check_devbox_homebrew
check_brew_bundle
check_cli_tools
check_no_legacy_tool_versions
check_config_paths
check_codex_config
check_spotlight_indexing
check_desktop_baseline

printf '\nbootstrap verification ok (%s)\n' "$profile"
