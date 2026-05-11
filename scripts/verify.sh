#!/usr/bin/env bash
set -euo pipefail

checks=(
  "brew --version"
  "git --version"
  "gh auth status"
  "node --version"
  "bun --version"
  "python --version"
  "java -version"
  "uv --version"
  "op --version"
)

check_mise_doctor() {
  local label="$1"
  local shell_flags="$2"
  local output

  printf '\n## mise doctor (%s)\n' "$label"
  output="$(zsh "$shell_flags" 'mise doctor' 2>&1)"
  printf '%s\n' "$output"

  if grep -q 'tool paths are not first in PATH' <<< "$output"; then
    printf '\n## PATH (%s)\n' "$label" >&2
    zsh "$shell_flags" 'print -l ${(s/:/)PATH} | nl -ba | sed -n "1,60p"' >&2
    printf 'FAILED: mise tool paths are not first in PATH (%s)\n' "$label" >&2
    exit 1
  fi
}

check_mise_doctor "login interactive" -lic
check_mise_doctor "interactive" -ic

for check in "${checks[@]}"; do
  printf '\n## %s\n' "$check"
  if ! zsh -lic "$check"; then
    printf 'FAILED: %s\n' "$check" >&2
    exit 1
  fi
done

printf '\n## config files\n'
if [ -e "$HOME/.tool-versions" ] || [ -L "$HOME/.tool-versions" ]; then
  printf 'legacy ~/.tool-versions exists; use ~/.config/mise/config.toml or repo-local tool files instead\n' >&2
  exit 1
fi

for path in \
  "$HOME/.config/zed/settings.json" \
  "$HOME/.config/zed/keymap.json" \
  "$HOME/Library/Application Support/com.mitchellh.ghostty/config" \
  "$HOME/.gitconfig" \
  "$HOME/.gitconfig.local"; do
  if [ -e "$path" ]; then
    printf 'ok %s\n' "$path"
  else
    printf 'missing %s\n' "$path" >&2
    exit 1
  fi
done

printf '\nbootstrap verification ok\n'
