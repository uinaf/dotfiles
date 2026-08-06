#!/usr/bin/env bash

# Run login/interactive zsh probes without inheriting the caller's mise session
# or PATH. Live bootstrap checks must observe the target shell's own startup
# ordering, not an already-activated parent shell.

dotfiles_clean_login_path() {
  local path="/usr/bin:/bin:/usr/sbin:/sbin"

  if [ -d /opt/homebrew/bin ]; then
    path="/opt/homebrew/bin:/opt/homebrew/sbin:${path}"
  elif [ -d /usr/local/bin ]; then
    path="/usr/local/bin:${path}"
  fi
  printf '%s\n' "$path"
}

dotfiles_run_clean_zsh() {
  local flags="$1"
  shift
  local zsh_bin="${DOTFILES_ZSH_BIN:-/bin/zsh}"

  env -i \
    HOME="$HOME" \
    USER="${USER:-$(id -un)}" \
    LOGNAME="${LOGNAME:-$(id -un)}" \
    SHELL="${SHELL:-/bin/zsh}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    TERM="${TERM:-dumb}" \
    LANG="${LANG:-C}" \
    PATH="$(dotfiles_clean_login_path)" \
    "$zsh_bin" "$flags" "$@"
}
