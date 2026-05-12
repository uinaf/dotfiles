#!/usr/bin/env bash
set -euo pipefail

cli_checks=(
  "brew --version"
  "git --version"
  "gh auth status"
  "node --version"
  "bun --version"
  "python --version"
  "java -version"
  "uv --version"
  "op --version"
  "codex --version"
  "tailscale status --peers=false"
)

config_paths=(
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

check_config_paths() {
  local path

  section "config files"
  for path in "${config_paths[@]}"; do
    if [ -e "$path" ]; then
      printf 'ok %s\n' "$path"
    else
      fail "missing $path"
    fi
  done
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

check_cli_tools() {
  local check

  for check in "${cli_checks[@]}"; do
    run_zsh_check "$check"
  done
}

check_mise
check_cli_tools
check_no_legacy_tool_versions
check_config_paths
check_codex_config

printf '\nbootstrap verification ok\n'
