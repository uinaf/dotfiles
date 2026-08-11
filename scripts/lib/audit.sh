#!/usr/bin/env bash

: "${json_output:=0}"
: "${warn_count:=0}"
: "${fail_count:=0}"

section() {
  [ "$json_output" -eq 1 ] && return
  printf '\n## %s\n' "$1"
}

ok() {
  [ "$json_output" -eq 1 ] && return
  printf 'ok %s\n' "$1"
}

warn() {
  warn_count=$((warn_count + 1))
  [ "$json_output" -eq 1 ] && return
  printf 'warn %s\n' "$1" >&2
}

fail_check() {
  fail_count=$((fail_count + 1))
  [ "$json_output" -eq 1 ] && return
  printf 'FAILED: %s\n' "$1" >&2
}

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}
