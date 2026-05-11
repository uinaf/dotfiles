# Login shell bootstrap. macOS path_helper has already run before this file.

if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv zsh)"
fi

typeset -U path PATH

# Add mise shims for login/non-interactive shells. Full interactive activation
# runs near the end of .zshrc after PATH edits.
if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate zsh --shims)"
fi
