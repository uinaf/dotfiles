export ZSH="$HOME/.oh-my-zsh"

ZSH_THEME="robbyrussell"
plugins=(git)

if [ -f "$ZSH/oh-my-zsh.sh" ]; then
  source "$ZSH/oh-my-zsh.sh"
fi

if [ -n "$SSH_CONNECTION$SSH_TTY" ] && [ -r "$HOME/.config/uinaf/devbox.env" ]; then
  PROMPT='%F{green}%n@%m%f %F{cyan}%~%f %# '
fi

export EDITOR="vim"

# SSH does not forward COLORTERM unless the server explicitly accepts it.
# Keep truecolor TUIs consistent when using Ghostty or another truecolor term.
if [ -n "$TERM" ] && [ -z "$COLORTERM" ]; then
  case "$TERM" in
    *-ghostty|*-direct|*-truecolor|*-24bit|xterm-256color|tmux-256color)
      export COLORTERM="truecolor"
      ;;
  esac
fi

if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv zsh)"
fi

typeset -U path PATH

# User binaries
path+=("$HOME/.local/bin")

# Vite+
if [ -f "$HOME/.vite-plus/env" ]; then
  . "$HOME/.vite-plus/env"
  path+=("$HOME/.vite-plus/bin")
fi

typeset -U path PATH

if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate zsh)"
else
  echo "mise not found, install with: brew install mise" >&2
fi

if command -v direnv >/dev/null 2>&1; then
  eval "$(direnv hook zsh)"
else
  echo "direnv not found, install with: brew install direnv" >&2
fi
