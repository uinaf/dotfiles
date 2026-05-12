#!/usr/bin/env bash
set -euo pipefail

timestamp="$(date +%Y%m%d%H%M%S)"
mode="certs"

if [ "${1:-}" = "--full" ]; then
  mode="full"
  shift
fi

if [ "$mode" = "full" ]; then
  output="${1:-$HOME/Desktop/tizen-migration-$timestamp.tar.gz}"
else
  output="${1:-$HOME/Desktop/tizen-certs-$timestamp.tar.gz}"
fi

manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT

paths=(
  "SamsungCertificate"
  ".tizen"
)

if [ "$mode" = "full" ]; then
  paths+=(
    "tizen-studio"
    "tizen-studio-data"
    "tizen-studio-extensions"
    "tizen-studio-workspace"
  )
else
  paths+=(
    "tizen-studio-data/profile"
  )
fi

for path in "${paths[@]}"; do
  if [ -e "$HOME/$path" ]; then
    printf '%s\n' "$path" >> "$manifest"
  else
    printf 'skip missing %s\n' "$HOME/$path" >&2
  fi
done

if [ ! -s "$manifest" ]; then
  printf 'no Tizen %s paths found; nothing to archive\n' "$mode" >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"
tar -C "$HOME" -czf "$output" -T "$manifest"

printf 'created %s\n' "$output"
printf 'mode: %s\n' "$mode"
printf 'contains:\n'
sed 's/^/  /' "$manifest"
printf '\nThis archive contains signing certificates/device keys. Do not commit it.\n'
