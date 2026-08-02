#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
agentless_signer="$repo_root/chezmoi/private_dot_local/private_libexec/private_dotfiles/private_executable_git-ssh-sign-agentless"
ghostty_config="$repo_root/chezmoi/private_Library/private_Application Support/com.mitchellh.ghostty/private_config"
run_security=1

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify/repo.sh [--skip-security]

Runs repository-level verification for dotfiles changes:
  - shell syntax checks for scripts and mise task files
  - ShellCheck for scripts and mise task files
  - Actionlint for GitHub workflows
  - whitespace/conflict-marker checks through git diff --check
  - AGENTS.md / CLAUDE.md entrypoint sanity
  - repo secret scan through scripts/audit/repo.sh --skip-mscp

This checks the repository, not the live machine bootstrap. Use
scripts/verify/bootstrap.sh for live workstation/devbox/assistant checks.
USAGE
}

section() {
  printf '\n## %s\n' "$1"
}

fail() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

need_command() {
  local command="$1"

  command -v "$command" >/dev/null 2>&1 \
    || fail "missing $command; install the developer Brewfile layers before repository verification"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-security)
      run_security=0
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

cd "$repo_root"

section "required tools"
need_command git
need_command bash
need_command chezmoi
need_command shellcheck
need_command node
if [ -d .github/workflows ]; then
  need_command actionlint
fi
if [ "$run_security" -eq 1 ]; then
  need_command gitleaks
  need_command trufflehog
fi
printf 'ok required tools are installed\n'

section "shell syntax"
{
  find scripts -name '*.sh' -print0
  printf '%s\0' "$agentless_signer"
  if [ -d .mise/tasks ]; then
    find .mise/tasks -type f -print0
  fi
} | xargs -0 bash -n
printf 'ok shell syntax\n'

section "Ghostty SSH integration"
grep -Fqx 'shell-integration-features = ssh-env,ssh-terminfo' "$ghostty_config" ||
  fail "managed Ghostty config does not enable SSH environment and terminfo integration"
printf 'ok managed Ghostty SSH environment and terminfo integration\n'

section "SOPS age identity"
./scripts/verify/sops-age-identity.sh

section "SOPS sudo runner"
./scripts/verify/sops-devbox-sudo.sh

section "devbox Homebrew wrapper"
./scripts/verify/brew-devbox.sh

section "profile contracts"
./scripts/verify/profiles.sh

section "Cursor desktop installer"
./scripts/verify/cursor-desktop.sh

section "agent sync contracts"
node --test scripts/agents/sync.test.ts

section "service labels"
./scripts/verify/service-labels.sh

section "audit contracts"
./scripts/verify/audit-contracts.sh

section "vendor-neutral interfaces"
./scripts/verify/vendor-neutral.sh

section "GitHub CLI extensions"
./scripts/verify/gh-extensions.sh

section "Assistant GitHub App authentication"
./scripts/verify/gh-app-auth.sh
./scripts/verify/configure-assistant-github-app.sh

section "Git bootstrap"
./scripts/verify/configure-git.sh

section "devbox zsh prompt"
./scripts/verify/zsh-prompt.sh

section "shellcheck"
{
  find scripts -name '*.sh' -print0
  printf '%s\0' "$agentless_signer"
  if [ -d .mise/tasks ]; then
    find .mise/tasks -type f -print0
  fi
} | xargs -0 shellcheck
printf 'ok shellcheck\n'

if [ -d .github/workflows ]; then
  section "github workflows"
  actionlint
  printf 'ok actionlint\n'
fi

section "git diff hygiene"
git diff --check
git diff --cached --check
printf 'ok git diff --check and git diff --cached --check\n'

section "agent entrypoints"
if [ ! -f AGENTS.md ]; then
  fail "missing AGENTS.md"
fi
if [ ! -L CLAUDE.md ] || [ "$(readlink CLAUDE.md)" != "AGENTS.md" ]; then
  fail "CLAUDE.md must be a symlink to AGENTS.md"
fi
printf 'ok AGENTS.md and CLAUDE.md\n'

if [ "$run_security" -eq 1 ]; then
  section "repository security audit"
  ./scripts/audit/repo.sh --skip-mscp
fi

printf '\nrepository verification ok\n'
