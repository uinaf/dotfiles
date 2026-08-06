#!/usr/bin/env bash

# Run login/interactive zsh probes without inheriting the caller's mise session
# or PATH. Live bootstrap checks must observe the target shell's own startup
# ordering, not an already-activated parent shell.
#
# The seed PATH is a minimal login-like base (Homebrew + system bins). Login
# probes (-l) usually rebuild PATH via path_helper; interactive-only probes
# (-i) keep this seed and then apply the target shell's own startup files.
# That is intentional: isolation from the caller matters more than reproducing
# a parent login shell's ambient PATH for -ic checks.

dotfiles_clean_login_path() {
  local path="/usr/bin:/bin:/usr/sbin:/sbin"

  if [ -d /opt/homebrew/bin ]; then
    path="/opt/homebrew/bin:/opt/homebrew/sbin:${path}"
  elif [ -d /usr/local/bin ]; then
    path="/usr/local/bin:/usr/local/sbin:${path}"
  fi
  printf '%s\n' "$path"
}

dotfiles_run_clean_zsh() {
  local flags="$1"
  shift
  local zsh_bin="${DOTFILES_ZSH_BIN:-/bin/zsh}"
  local -a env_args=(
    HOME="$HOME"
    USER="${USER:-$(id -un)}"
    LOGNAME="${LOGNAME:-$(id -un)}"
    SHELL="${SHELL:-/bin/zsh}"
    TMPDIR="${TMPDIR:-/tmp}"
    TERM="${TERM:-dumb}"
    LANG="${LANG:-C}"
    PATH="$(dotfiles_clean_login_path)"
  )

  # Forward non-mise config roots when set so the probe still reads the same
  # zsh/mise config tree as the workstation. Drop every mise session/PATH
  # activation variable by omission.
  [ -n "${ZDOTDIR:-}" ] && env_args+=("ZDOTDIR=$ZDOTDIR")
  [ -n "${XDG_CONFIG_HOME:-}" ] && env_args+=("XDG_CONFIG_HOME=$XDG_CONFIG_HOME")
  [ -n "${XDG_DATA_HOME:-}" ] && env_args+=("XDG_DATA_HOME=$XDG_DATA_HOME")
  [ -n "${XDG_STATE_HOME:-}" ] && env_args+=("XDG_STATE_HOME=$XDG_STATE_HOME")
  [ -n "${XDG_CACHE_HOME:-}" ] && env_args+=("XDG_CACHE_HOME=$XDG_CACHE_HOME")

  env -i "${env_args[@]}" "$zsh_bin" "$flags" "$@"
}
