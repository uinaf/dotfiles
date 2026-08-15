#!/usr/bin/env bash
set -euo pipefail

unset \
  GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_COMMON_DIR \
  GIT_CONFIG \
  GIT_CONFIG_COUNT \
  GIT_CONFIG_PARAMETERS \
  GIT_DIR \
  GIT_GRAFT_FILE \
  GIT_IMPLICIT_WORK_TREE \
  GIT_INDEX_FILE \
  GIT_NO_REPLACE_OBJECTS \
  GIT_OBJECT_DIRECTORY \
  GIT_PREFIX \
  GIT_REPLACE_REF_BASE \
  GIT_SHALLOW_FILE \
  GIT_WORK_TREE

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
zshrc="$repo_root/chezmoi/dot_zshrc"
test_home="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-zsh-prompt.XXXXXX")"

cleanup() {
  rm -rf "$test_home"
}
trap cleanup EXIT

mkdir -p "$test_home/.config/dotfiles"
touch "$test_home/.config/dotfiles/devbox.env"
mkdir -p \
  "$test_home/Library/Android/sdk/platform-tools" \
  "$test_home/Library/Android/sdk/emulator" \
  "$test_home/Library/Android/sdk/cmdline-tools/latest/bin"
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

# Let zsh expand the Android environment assertions.
# shellcheck disable=SC2016
env -i \
  HOME="$test_home" \
  PATH=/usr/bin:/bin \
  /bin/zsh -dfc '
    source "$1" 2>/dev/null
    expected="$HOME/Library/Android/sdk"
    [[ "$ANDROID_HOME" == "$expected" ]] || {
      print -u2 "FAILED: ANDROID_HOME is ${ANDROID_HOME:-unset}; expected $expected"
      exit 1
    }
    [[ "$path[1]" == "$expected/platform-tools" ]] || {
      print -u2 "FAILED: Android platform-tools is not first on PATH"
      exit 1
    }
    [[ "$path[2]" == "$expected/emulator" ]] || {
      print -u2 "FAILED: Android emulator is not second on PATH"
      exit 1
    }
    [[ "$path[3]" == "$expected/cmdline-tools/latest/bin" ]] || {
      print -u2 "FAILED: Android command-line tools are not third on PATH"
      exit 1
    }
    [[ -z "${ANDROID_SDK_ROOT:-}" ]] || {
      print -u2 "FAILED: deprecated ANDROID_SDK_ROOT is set"
      exit 1
    }
  ' zsh "$zshrc"

printf 'ok devbox zsh prompt substitution and Android SDK environment\n'
