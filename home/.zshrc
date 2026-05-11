export ZSH="$HOME/.oh-my-zsh"

ZSH_THEME="robbyrussell"
plugins=(git)

if [ -f "$ZSH/oh-my-zsh.sh" ]; then
  source "$ZSH/oh-my-zsh.sh"
fi

export EDITOR="vim"

if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv zsh)"
fi

typeset -U path PATH

# User binaries
path+=("$HOME/.local/bin")

# Optional agent/tool bins
path+=("$HOME/.opencode/bin")

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
