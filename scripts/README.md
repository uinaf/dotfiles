# Scripts

Run commands from the repository root. [mise.toml](../mise.toml) exposes the
tasks; [Bootstrap](../docs/bootstrap.md) owns operator setup, and
[verification checks](verify/checks.json) map implementation changes to proof.

## Automation

Install dependencies with `pnpm install --frozen-lockfile`.
Shared Effect services live in [lib/](lib/); scripts own parsing, policy,
filesystem changes, and command orchestration. Read the Effect guidance named
in [AGENTS.md](../AGENTS.md) before changing them.

Shell is reserved for standalone process boundaries: the root launcher,
external-client credential adapters in [agents/](agents/), and sudo's
[askpass helper](lib/sudo-age-askpass.sh). These must run without the
repository's Node module graph.

Use [Mise tasks](../docs/mise.md#tasks) for checks and
[Security audits](../docs/security-audits.md) before collecting live host output.
