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
zprofile="$repo_root/chezmoi/dot_zprofile"
test_home="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-zsh-prompt.XXXXXX")"

cleanup() {
  rm -rf "$test_home"
}
trap cleanup EXIT

mkdir -p "$test_home/.config/dotfiles"
touch "$test_home/.config/dotfiles/devbox.env"
ln -s "$zprofile" "$test_home/.zprofile"
zshrc="$test_home/.zshrc.rendered"
data='{"dotfilesProfile":"personal-devbox"}'
chezmoi \
  --source "$repo_root/chezmoi" \
  --destination "$test_home" \
  --override-data "$data" \
  cat "$test_home/.zshrc" > "$zshrc"
mkdir -p \
  "$test_home/.local/bin" \
  "$test_home/Library/Android/sdk/platform-tools" \
  "$test_home/Library/Android/sdk/emulator" \
  "$test_home/Library/Android/sdk/cmdline-tools/latest/bin"
git init -q "$test_home/repo"
git -C "$test_home/repo" symbolic-ref HEAD refs/heads/demo

# Login and non-interactive agent shells must discover managed user commands.
# shellcheck disable=SC2016
env -i \
  HOME="$test_home" \
  PATH=/usr/bin:/bin \
  /bin/zsh -dlc '
    (( ${path[(Ie)$HOME/.local/bin]} > 0 )) || {
      print -u2 "FAILED: user-local bin is absent from login PATH: ${PATH}"
      exit 1
    }
  '

# A nested login shell from a mise-active parent inherits the shim directory
# late in PATH; mise activate emits no update then, so the zprofile must
# re-front the shims ahead of Homebrew itself.
mise_shims="$test_home/.local/share/mise/shims"
mkdir -p "$mise_shims" "$test_home/fake-tools"
cat >"$test_home/fake-tools/mise" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 755 "$test_home/fake-tools/mise"
# shellcheck disable=SC2016
env -i \
  HOME="$test_home" \
  PATH="$test_home/fake-tools:/opt/homebrew/bin:/usr/bin:/bin:$mise_shims" \
  /bin/zsh -dlc '
    shims="$HOME/.local/share/mise/shims"
    (( ${path[(Ie)$shims]} == 1 )) || {
      print -u2 "FAILED: inherited mise shims are not first on login PATH: ${PATH}"
      exit 1
    }
    brew_index=${path[(Ie)/opt/homebrew/bin]}
    (( brew_index > 1 )) || {
      print -u2 "FAILED: inherited Homebrew bin left the login PATH: ${PATH}"
      exit 1
    }
  '

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

# Interactive shells rerun brew shellenv in .zshrc, which re-fronted Homebrew
# ahead of the login-shell shims, and zsh -ic never fires the activation hook
# that would repair PATH. Sourcing the rendered zshrc with an inherited
# brew-before-shims PATH must leave the shims ahead of Homebrew again.
# shellcheck disable=SC2016
env -i \
  HOME="$test_home" \
  PATH="$test_home/fake-tools:/opt/homebrew/bin:/usr/bin:/bin:$mise_shims" \
  /bin/zsh -dfc '
    source "$1" 2>/dev/null
    shims_index=${path[(Ie)$HOME/.local/share/mise/shims]}
    brew_index=${path[(Ie)/opt/homebrew/bin]}
    (( shims_index > 0 )) || {
      print -u2 "FAILED: mise shims left the interactive PATH: ${PATH}"
      exit 1
    }
    (( brew_index == 0 || shims_index < brew_index )) || {
      print -u2 "FAILED: Homebrew precedes mise shims after zshrc: ${PATH}"
      exit 1
    }
  ' zsh "$zshrc"

printf 'ok login PATH, mise shim precedence, devbox zsh prompt substitution, and Android SDK environment\n'
