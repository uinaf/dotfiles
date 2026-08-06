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

dotfiles_probe_zsh_bin() {
  local candidate

  if [ -n "${DOTFILES_ZSH_BIN:-}" ] && [ -x "${DOTFILES_ZSH_BIN}" ]; then
    printf '%s\n' "${DOTFILES_ZSH_BIN}"
    return 0
  fi

  # Prefer the workstation login shell when it is zsh. Do not use `command -v
  # zsh` here: an activated mise session can put a zsh shim first on PATH.
  if [ -n "${SHELL:-}" ] && [ -x "${SHELL}" ]; then
    case "$(basename "${SHELL}")" in
      zsh)
        printf '%s\n' "${SHELL}"
        return 0
        ;;
    esac
  fi

  for candidate in /opt/homebrew/bin/zsh /usr/local/bin/zsh /bin/zsh; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '%s\n' /bin/zsh
}

dotfiles_run_clean_zsh() {
  local flags="$1"
  shift
  local zsh_bin
  zsh_bin="$(dotfiles_probe_zsh_bin)"
  local -a env_args=(
    HOME="$HOME"
    USER="${USER:-$(id -un)}"
    LOGNAME="${LOGNAME:-$(id -un)}"
    SHELL="${SHELL:-$zsh_bin}"
    TMPDIR="${TMPDIR:-/tmp}"
    TERM="${TERM:-dumb}"
    LANG="${LANG:-C}"
    PATH="$(dotfiles_clean_login_path)"
  )

  # Forward non-session config roots when set so the probe still reads the same
  # zsh/mise config tree as the workstation. Drop mise session/PATH activation
  # variables (MISE_SHELL, __MISE_SESSION, __MISE_ORIG_PATH,
  # __MISE_ZSH_ACTIVATE_PATH) by omission.
  [ -n "${ZDOTDIR:-}" ] && env_args+=("ZDOTDIR=$ZDOTDIR")
  [ -n "${XDG_CONFIG_HOME:-}" ] && env_args+=("XDG_CONFIG_HOME=$XDG_CONFIG_HOME")
  [ -n "${XDG_DATA_HOME:-}" ] && env_args+=("XDG_DATA_HOME=$XDG_DATA_HOME")
  [ -n "${XDG_STATE_HOME:-}" ] && env_args+=("XDG_STATE_HOME=$XDG_STATE_HOME")
  [ -n "${XDG_CACHE_HOME:-}" ] && env_args+=("XDG_CACHE_HOME=$XDG_CACHE_HOME")
  [ -n "${MISE_CONFIG_DIR:-}" ] && env_args+=("MISE_CONFIG_DIR=$MISE_CONFIG_DIR")
  [ -n "${MISE_DATA_DIR:-}" ] && env_args+=("MISE_DATA_DIR=$MISE_DATA_DIR")
  [ -n "${MISE_GLOBAL_CONFIG_FILE:-}" ] && env_args+=("MISE_GLOBAL_CONFIG_FILE=$MISE_GLOBAL_CONFIG_FILE")
  [ -n "${MISE_TRUSTED_CONFIG_PATHS:-}" ] && env_args+=("MISE_TRUSTED_CONFIG_PATHS=$MISE_TRUSTED_CONFIG_PATHS")
  [ -n "${MISE_ENV:-}" ] && env_args+=("MISE_ENV=$MISE_ENV")

  env -i "${env_args[@]}" "$zsh_bin" "$flags" "$@"
}
