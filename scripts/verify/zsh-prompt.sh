#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
zshrc="$repo_root/chezmoi/dot_zshrc"
test_home="$(mktemp -d "${TMPDIR:-/tmp}/uinaf-zsh-prompt.XXXXXX")"

cleanup() {
  rm -rf "$test_home"
}
trap cleanup EXIT

mkdir -p "$test_home/.config/uinaf"
touch "$test_home/.config/uinaf/devbox.env"
git init -q "$test_home/repo"
git -C "$test_home/repo" symbolic-ref HEAD refs/heads/demo

# Let zsh expand the embedded prompt expressions.
# shellcheck disable=SC2016
env -i \
  HOME="$test_home" \
  PATH=/usr/bin:/bin \
  SSH_CONNECTION='test' \
  TERM=xterm-256color \
  /bin/zsh -dfc '
    source "$1" 2>/dev/null
    [[ -o promptsubst ]] || {
      print -u2 "FAILED: devbox prompt substitution is disabled"
      exit 1
    }

    cd "$HOME/repo"
    helper="$(devbox_git_prompt_info)"
    [[ "$helper" == *demo* ]] || {
      print -u2 "FAILED: devbox Git helper did not resolve the current branch: ${helper}"
      exit 1
    }

    rendered="$(print -P -- "$PROMPT")"
    [[ "$rendered" == *demo* ]] || {
      print -u2 "FAILED: devbox Git prompt did not render: ${rendered}"
      exit 1
    }
    [[ "$rendered" != *"\$(devbox_git_prompt_info)"* ]] || {
      print -u2 "FAILED: devbox Git prompt command was rendered literally"
      exit 1
    }
  ' zsh "$zshrc"

printf 'ok devbox zsh prompt substitution\n'
