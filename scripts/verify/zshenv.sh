#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
zshenv="$repo_root/chezmoi/dot_zshenv"
test_home="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-zshenv.XXXXXX")"

cleanup() {
  rm -rf "$test_home"
}
trap cleanup EXIT

mkdir -p "$test_home/.config/dotfiles"
ln -s "$zshenv" "$test_home/.zshenv"

run_zshenv() {
  env -i HOME="$test_home" PATH=/usr/bin:/bin /bin/zsh -c "$1"
}

run_zshenv '
  [[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]] || {
    print -u2 "FAILED: missing overlay leaked DOTFILES_ZSHENV_LOCAL"
    exit 1
  }
'

printf 'export DOTFILES_ZSHENV_LOCAL=from-local\n' >"$test_home/.config/dotfiles/zshenv.local"

run_zshenv '
  [[ "$DOTFILES_ZSHENV_LOCAL" == from-local ]] || {
    print -u2 "FAILED: overlay did not export DOTFILES_ZSHENV_LOCAL"
    exit 1
  }
'

rm "$test_home/.config/dotfiles/zshenv.local"
mkdir "$test_home/.config/dotfiles/zshenv.local"

run_zshenv '
  [[ -z ${DOTFILES_ZSHENV_LOCAL+x} ]] || {
    print -u2 "FAILED: directory overlay was sourced"
    exit 1
  }
'

printf 'zshenv overlay ok\n'
