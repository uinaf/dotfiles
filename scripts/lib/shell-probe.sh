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
  local prefix

  # Include every present Homebrew-style prefix. Prefer Apple Silicon first so
  # it wins when both exist, matching typical workstation layout. Honor an
  # explicit HOMEBREW_PREFIX for relocated installs.
  if [ -d /usr/local/bin ]; then
    path="/usr/local/bin:/usr/local/sbin:${path}"
  fi
  if [ -d /opt/homebrew/bin ]; then
    path="/opt/homebrew/bin:/opt/homebrew/sbin:${path}"
  fi
  prefix="${HOMEBREW_PREFIX:-}"
  prefix="${prefix%/}"
  if [ -n "$prefix" ] && [ -d "$prefix/bin" ]; then
    case ":$path:" in
      *:"$prefix/bin":*) ;;
      *) path="$prefix/bin:$prefix/sbin:${path}" ;;
    esac
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
    case "${SHELL##*/}" in
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

  printf 'no zsh found for PATH probe; set DOTFILES_ZSH_BIN\n' >&2
  return 1
}

dotfiles_run_clean_zsh() {
  local flags="$1"
  shift
  local zsh_bin
  zsh_bin="$(dotfiles_probe_zsh_bin)" || return 1
  # Resolve id via the system default PATH, not the caller's (possibly
  # mise-broken) PATH, before env -i replaces the environment.
  local probe_user
  probe_user="${USER:-$(command -p id -un)}"
  local -a env_args=(
    HOME="$HOME"
    USER="$probe_user"
    LOGNAME="${LOGNAME:-$probe_user}"
    SHELL="$zsh_bin"
    TMPDIR="${TMPDIR:-/tmp}"
    PATH="$(dotfiles_clean_login_path)"
  )

  # Forward locale/terminal when set. Do not invent TERM=dumb — many zsh
  # startup files treat that as a non-interactive/tramp sentinel.
  [ -n "${TERM:-}" ] && env_args+=("TERM=$TERM")
  [ -n "${LANG:-}" ] && env_args+=("LANG=$LANG")
  [ -n "${LC_ALL:-}" ] && env_args+=("LC_ALL=$LC_ALL")
  [ -n "${HOMEBREW_PREFIX:-}" ] && env_args+=("HOMEBREW_PREFIX=$HOMEBREW_PREFIX")

  # Allowlist is deliberate: build a clean login-like environment, not a
  # denylist over the caller's ambient state. Forward non-session config roots
  # when set so the probe still reads the same zsh/mise config tree. Drop mise
  # session/PATH activation variables (MISE_SHELL, __MISE_SESSION,
  # __MISE_ORIG_PATH, __MISE_ZSH_ACTIVATE_PATH) by omission.
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
