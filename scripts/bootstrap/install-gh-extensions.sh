#!/usr/bin/env bash
set -euo pipefail

extension="github/gh-stack"

if ! command -v gh >/dev/null 2>&1; then
  printf 'gh is required; install the shared Brewfile first\n' >&2
  exit 1
fi

printf 'installing GitHub CLI extension %s\n' "$extension"
gh extension install "$extension" --force
gh stack --help >/dev/null
printf 'ok gh-stack is installed\n'
