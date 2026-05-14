#!/usr/bin/env bash
set -euo pipefail

profile="personal"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify/bootstrap.sh [--profile personal|devbox]

Checks the live machine bootstrap for the selected profile. The default profile
is personal for backward compatibility.
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

common_cli_checks=(
  "brew --version"
  "git --version"
  "gh auth status"
  "mise --version"
  "node --version"
  "bun --version"
  "python --version"
  "java -version"
  "uv --version"
  "op --version"
  "codex --version"
  "tailscale status --peers=false"
)

personal_cli_checks=(
  "gitcrawl --version"
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
    BEGIN { ok_model = ok_reasoning = ok_goals = ok_memories = 0; in_top = 1; in_features = 0 }
    /^[[:space:]]*\[/ { in_top = 0; in_features = ($0 == "[features]") }
    in_top && $0 == "model = \"gpt-5.5\"" { ok_model = 1 }
    in_top && $0 == "model_reasoning_effort = \"high\"" { ok_reasoning = 1 }
    in_features && $0 == "goals = true" { ok_goals = 1 }
    in_features && $0 == "memories = true" { ok_memories = 1 }
    END { exit !(ok_model && ok_reasoning && ok_goals && ok_memories) }
  ' "$config" || fail "Codex defaults are not configured in $config"
  printf 'ok Codex model/features defaults\n'
}

check_mise() {
  check_mise_doctor "login interactive" -lic
  check_mise_doctor "interactive" -ic
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
check_brew_bundle
check_cli_tools
check_no_legacy_tool_versions
check_config_paths
check_codex_config

printf '\nbootstrap verification ok (%s)\n' "$profile"
