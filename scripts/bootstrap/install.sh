#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
profile=""
print_steps=0

# shellcheck source=scripts/lib/profile.sh
. "$repo_root/scripts/lib/profile.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/bootstrap/install.sh --profile personal-workstation|personal-devbox|workstation|devbox|assistant|service
  scripts/bootstrap/install.sh --print-steps --profile PROFILE

Applies per-user dotfiles and runs only the setup steps owned by the selected
role. An existing ~/.config/dotfiles/profile is used when --profile is omitted.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      if [ "$#" -eq 0 ]; then
        usage >&2
        exit 2
      fi
      profile="$1"
      ;;
    --print-steps)
      print_steps=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if ! profile="$(dotfiles_resolve_profile "$profile")"; then
  printf 'a supported profile is required: personal-workstation, personal-devbox, workstation, devbox, assistant, or service\n' >&2
  exit 2
fi

install_steps() {
  printf 'apply-dotfiles\n'
  if [ "$profile" = "assistant" ]; then
    printf 'install-gh-app-auth\n'
  elif dotfiles_profile_is_developer "$profile"; then
    printf 'install-cursor-agent\n'
    printf 'trust-agent-worktrees\n'
    printf 'install-gh-extensions\n'
    printf 'remove-global-vite-plus\n'
    printf 'install-pnpm\n'
    printf 'configure-codex\n'
    printf 'sync-agents\n'
  fi
}

run_step() {
  case "$1" in
    apply-dotfiles)
      "$repo_root/scripts/bootstrap/apply-dotfiles.sh" --profile "$profile"
      ;;
    install-gh-app-auth)
      "$repo_root/scripts/bootstrap/install-gh-app-auth.sh"
      ;;
    install-cursor-agent)
      "$repo_root/scripts/bootstrap/install-cursor-agent.sh"
      ;;
    trust-agent-worktrees)
      "$repo_root/scripts/bootstrap/trust-agent-worktrees.sh"
      ;;
    install-gh-extensions)
      "$repo_root/scripts/bootstrap/install-gh-extensions.sh"
      ;;
    remove-global-vite-plus)
      if command -v mise >/dev/null 2>&1; then
        installed_vite_plus="$(mise ls npm:vite-plus --installed --json)"
        if printf '%s\n' "$installed_vite_plus" | grep -Eq '"installed":[[:space:]]*true'; then
          mise uninstall --all --yes npm:vite-plus
        fi
        installed_nodes="$(mise ls node --installed --json)"
        if [ -n "$installed_nodes" ] && command -v node >/dev/null 2>&1; then
          printf '%s\n' "$installed_nodes" \
            | node -e 'for (const tool of JSON.parse(require("node:fs").readFileSync(0, "utf8"))) console.log(tool.install_path)' \
            | while IFS= read -r node_root; do
                if [ -f "$node_root/lib/node_modules/vite-plus/package.json" ]; then
                  npm_config_prefix="$node_root" "$node_root/bin/npm" uninstall --global vite-plus
                fi
              done
        fi
        mise reshim --force
      fi
      ;;
    install-pnpm)
      if command -v corepack >/dev/null 2>&1; then
        corepack enable pnpm
        corepack install --global pnpm@11.20.0
      else
        printf 'skipped pnpm setup; install the pinned Node runtime with Corepack support\n' >&2
      fi
      ;;
    configure-codex)
      if command -v codex >/dev/null 2>&1; then
        "$repo_root/scripts/bootstrap/configure-codex.sh"
      else
        printf 'skipped Codex defaults; codex is not on PATH yet\n' >&2
      fi
      ;;
    sync-agents)
      "$repo_root/scripts/agents/sync.ts" --profile "$profile"
      ;;
    *)
      printf 'unsupported install step: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

if [ "$print_steps" -eq 1 ]; then
  install_steps
  exit 0
fi

steps=()
while IFS= read -r step; do
  steps+=("$step")
done < <(install_steps)
for step in "${steps[@]}"; do
  run_step "$step"
done
