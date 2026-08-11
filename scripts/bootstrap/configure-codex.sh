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

set_known_feature() {
  local feature="$1"
  local action="$2"

  if CODEX_HOME="$codex_home" codex features list | awk -v feature="$feature" '$1 == feature { found = 1 } END { exit !found }'; then
    CODEX_HOME="$codex_home" codex features "$action" "$feature" >/dev/null
  else
    printf 'skipped unknown Codex feature: %s\n' "$feature" >&2
  fi
}

# Hard requirement: ChatGPT subscription login, not API-key billing.
set_top_level "forced_login_method" '"chatgpt"'

# Soft first-boot defaults; users may change these afterward.
set_top_level "model" '"gpt-5.6-sol"'
set_top_level "model_reasoning_effort" '"medium"'
set_top_level "service_tier" '"default"'

if ! command -v codex >/dev/null 2>&1; then
  printf 'missing required command: codex\n' >&2
  exit 1
fi

set_known_feature "fast_mode" "disable"
set_known_feature "goals" "enable"
set_known_feature "memories" "enable"

printf 'configured Codex defaults in %s\n' "$config_path"
