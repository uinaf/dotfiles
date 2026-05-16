# Mise Tasks

This repo uses mise in two different scopes:

- Root `mise.toml` defines repo tasks for humans and agents.
- `chezmoi/private_dot_config/mise/config.toml` defines machine runtime and
  tool versions applied into `~/.config/mise/config.toml`.

Do not mix those scopes. A task belongs in root `mise.toml`; a shared machine
runtime pin belongs in the chezmoi-managed home config.

## Tasks

Keep tasks deterministic and non-interactive:

- Use explicit repo-relative commands such as `./scripts/verify/repo.sh`.
- Add a concise `description` for every task.
- Prefer task names users can guess: `verify`, `verify:fast`,
  `dotfiles:diff`, `dotfiles:apply`.
- Do not embed secrets, hostnames, personal paths, or environment-specific
  credentials.
- Do not replace repo scripts with long inline shell when a script already owns
  the behavior.

Inspect tasks with:

```zsh
mise tasks --json
```

Run the changed task directly, then run:

```zsh
mise run verify
```

## Runtime Pins

When changing `chezmoi/private_dot_config/mise/config.toml`:

1. Confirm the pin is intended for all uinaf machines.
2. Keep exact versions where practical.
3. Preview dotfile output with `mise run dotfiles:diff`.
4. Run `mise run verify`.

Avoid floating runtime versions such as `latest` in shared machine config.
