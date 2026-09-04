# Identity Provisioning

This repository provisions human identities. A deployment binds an identity
to one Unix user on one host. Credentials grant specific capabilities to that
deployment; a profile only selects software and defaults.

```text
Identity: example-developer
└── Deployment: example-developer@example-host
    ├── Unix user
    ├── age identity
    ├── optional SSH identity
    ├── Git authorship
    └── scoped provider credentials
```

Do not create one master credential for an identity. Age, SSH, GitHub, and
provider credentials must remain independently replaceable.

## Capability Policy

| Capability | Workstation | Devbox |
| --- | --- | --- |
| Age identity | optional until secrets are consumed | required |
| SSH private identity | required | required |
| Human GitHub login | expected | expected |
| Git signing identity | required | required |
| Git authorship metadata | required | required |
| Provider credentials | identity-scoped | identity-scoped |

- Personal uses the workstation identity policy; personal-devbox uses the
  devbox identity policy.
- Inbound SSH does not require the user to own a private SSH key. Put an
  administrator's public key in the target user's `authorized_keys`.

## Developer Git and SSH

`workstation`, `personal-workstation`, `personal-devbox`, and `devbox` users
require explicit Git authorship and an owner-only, unencrypted local SSH private
key for unattended commit signing. Agent-backed, encrypted, and public-key-only
signing paths are unsupported.

If the key comes from a human recovery system, export it in OpenSSH format
without a passphrase, save it outside this repository, derive its public key,
and lock down both files:

```zsh
chmod 0600 ~/.ssh/developer_ed25519
ssh-keygen -y -f ~/.ssh/developer_ed25519 > ~/.ssh/developer_ed25519.pub
chmod 0644 ~/.ssh/developer_ed25519.pub
```

Configure authorship and signing from explicit operator values:

```zsh
profile=workstation
GIT_USER_NAME='Developer Name' \
GIT_USER_EMAIL='developer@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/developer_ed25519" \
GIT_SSH_IDENTITY_FILE="$HOME/.ssh/developer_ed25519" \
  ./scripts/bootstrap/configure-git.ts --profile "$profile" --non-interactive
```

- `GIT_SSH_IDENTITY_FILE` may point to a different local key.
- GitHub registers authentication and signing keys separately; add the public key
  for each role the deployment uses.
- The configurator writes authorship and signing state to `~/.gitconfig.local`.
- When SSH authentication is configured, it also writes a managed
  `~/.ssh/github.config` block that selects the local key and disables ambient
  agent identities and key additions for `github.com`.
- Keep unrelated directives in `~/.ssh/config.local`.
- Move aside an unmanaged `~/.ssh/github.config` or any other
  `Host github.com` block before running the configurator.

## SOPS Age Identity

Age calls the private decryption key an **identity** and its derived public
encryption address a **recipient**.

- Secret-consuming deployments (`personal-devbox`, `devbox`, and
  vault or sudo consumers) require one general SOPS age identity per managed
  Unix user.
- Portable `workstation` and `personal-workstation` profiles keep the SOPS CLI
  without an identity until they decrypt encrypted material.
- Keep sudo-specific age identities separate: they protect a different
  capability and have a different rotation lifecycle.

Install the selected profile's Homebrew layers, then provision the identity
when the deployment will decrypt secrets:

```sh
./scripts/secrets/configure-sops-age-identity.ts
```

The command is idempotent:

- Creates an identity only when one does not exist.
- Sets owner-only permissions and derives the public recipient.
- Proves a real SOPS encrypt/decrypt round trip.
- Never prints the private identity.

SOPS' native default paths are used:

| Platform | Private identity path |
| --- | --- |
| macOS | `~/Library/Application Support/sops/age/keys.txt` |
| Linux | `~/.config/sops/age/keys.txt` |

`XDG_CONFIG_HOME` changes the config root. Set `SOPS_AGE_KEY_FILE` only when an
explicit owner-only path is required. Check an existing identity without
creating or repairing it:

```sh
./scripts/secrets/configure-sops-age-identity.ts --check
```

Print only the safe public recipient for a registry or SOPS policy:

```sh
./scripts/secrets/configure-sops-age-identity.ts --print-recipient
```

Provisioning is complete only after the private identity has a verified human
recovery copy and the owning encrypted repository has authorized its public
recipient:

1. Generate or check the local identity with the commands above.
2. Back up and verify the private identity using the recovery procedure below.
3. Give only the public `age1...` recipient to the encrypted repository owner.
4. Add that recipient to the repository's `.sops.yaml` and update the affected
   encrypted files with `sops updatekeys`.
5. Prove the deployment can decrypt only the payloads it should consume.

Repository membership alone never grants decryption. Git access controls who
can fetch ciphertext; the recipient policy controls which age identities can
decrypt it.

## Back Up and Verify Recovery

Generation and recovery registration are one provisioning operation. Keep one
human-controlled recovery item per deployment, not one password-manager item
per private file. Attach independently replaceable credentials as separately
labeled files in that item:

- general age identity
- sudo-specific age identity when the deployment uses unattended sudo
- SSH private key only when the deployment initiates outbound SSH
- account recovery material when the operator's policy permits it

Do not merge the credentials into one private key or paste their values into a
note. The item is an inventory and recovery boundary; each attached credential
keeps its own scope and rotation lifecycle.

Before using a new general SOPS age identity for live ciphertext:

1. Create or select the deployment's recovery item.
2. Attach the general SOPS age identity file and record the deployment name,
   public recipient, creation date, and local path.
3. Restore that general SOPS age identity attachment to an owner-only temporary
   path and run `age-keygen -y /path/to/restored-keys.txt`.
4. Confirm the restored general age recipient exactly matches
   `configure-sops-age-identity.ts --print-recipient`.
5. Validate each other applicable attachment against its own live source or
   derive and compare its public identity without exposing the private value.
6. Remove the temporary restored copies.

Do not print or paste the private identity into shell history, logs, issues,
pull requests, chat, or repository files. Routine unattended workloads must
not have access to the human recovery system.

## Encrypted Secret Repositories

Consumer repositories own their `.sops.yaml`, encrypted payloads, runtime
wrapper, and recipient policy. This dotfiles repo owns only the portable tools,
identity provisioning, and local verification.

For a new vault, the optional
[SOPS vault template](https://github.com/uinaf/sops-vault-template) provides a
small standalone starting point with recipient policy, safe create/edit
commands, and verification:

1. Create a private repository from the template.
2. Replace its example recipients with the public recovery and deployment
   recipients.
3. Run `mise run verify`.

The generated repository owns its copied scripts and policy; it does not depend
on this dotfiles repository or the template after creation.

Safe repository state may include:

- public age recipients and SSH fingerprints
- GitHub App slug, App ID, and installation ID
- Git author name and email
- SOPS-encrypted files and `.sops.yaml`

Never commit:

- age private identities
- SSH private keys
- GitHub App private keys
- provider tokens or decrypted dotenv files
- password-manager item references tied to a private environment

Prefer one provider credential per identity. If a credential must be shared,
encrypt the shared file only to the explicitly approved identity recipients
and the human recovery recipient. Repository read access controls availability
and integrity; the SOPS recipient set controls who can decrypt.

## Move or Retire a Deployment

Create a new age identity when an identity moves to another host. Do not copy
the old deployment's private identity.

1. Generate and back up the new deployment identity.
2. Add its public recipient to the owning repository's `.sops.yaml`.
3. Run `sops updatekeys --yes path/to/secrets.sops.yaml` for each affected
   file.
4. Prove the new deployment can decrypt its files and cannot decrypt sibling
   identity files.
5. Remove the old recipient and update the encrypted files again.
6. Rotate the underlying secrets before retiring the old deployment because
   old Git revisions remain decryptable by the old identity.
7. Remove the old local identity and archive its recovery item.
