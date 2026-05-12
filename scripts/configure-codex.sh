#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"
config_path="${CODEX_CONFIG_PATH:-$codex_home/config.toml}"

mkdir -p "$(dirname "$config_path")"
touch "$config_path"
chmod 0600 "$config_path"

set_top_level() {
  local key="$1"
  local value="$2"
  local tmp

  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    !done && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      print key " = " value
      done = 1
      next
    }
    !done && /^[[:space:]]*\[/ {
      print key " = " value
      done = 1
    }
    { print }
    END {
      if (!done) {
        print key " = " value
      }
    }
  ' "$config_path" > "$tmp"
  install -m 0600 "$tmp" "$config_path"
  rm -f "$tmp"
}

set_top_level "model" '"gpt-5.5"'
set_top_level "model_reasoning_effort" '"high"'

if ! command -v codex >/dev/null 2>&1; then
  printf 'missing required command: codex\n' >&2
  exit 1
fi

CODEX_HOME="$codex_home" codex features enable goals >/dev/null
CODEX_HOME="$codex_home" codex features enable memories >/dev/null

printf 'configured Codex defaults in %s\n' "$config_path"
