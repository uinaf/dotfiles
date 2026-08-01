# Identity Provisioning

An identity is a human or workload principal. A deployment binds that identity
to one Unix user on one host. Credentials grant specific capabilities to that
deployment; a profile only selects software and defaults.

```text
Identity: example-assistant
└── Deployment: example-assistant@example-host
    ├── Unix user
    ├── age identity
    ├── optional SSH identity
    ├── Git authorship
    ├── optional GitHub App
    └── scoped provider credentials
```

Do not create one master credential for an identity. Age, SSH, GitHub, and
provider credentials must remain independently replaceable.

## Capability Policy

| Capability | Workstation | Devbox | Assistant |
| --- | --- | --- | --- |
| Age identity | required | required | required |
| SSH private identity | required | required | only for required outbound SSH |
| GitHub App | optional | optional | preferred for repository access |
| Human GitHub login | expected | allowed unless App-based | forbidden |
| Git signing identity | required | required | disabled |
| Git authorship metadata | required | required | required |
| Provider credentials | identity-scoped | identity-scoped | identity-scoped |

Inbound SSH does not require the workload to own a private SSH key. Put an
administrator's public key in the target user's `authorized_keys`. Provision a
private SSH identity for an assistant only when the assistant must initiate an
SSH connection.

## SOPS Age Identity

Age calls the private decryption key an **identity** and its derived public
encryption address a **recipient**. Every managed Unix user gets one general
SOPS age identity. Keep sudo-specific age identities separate because they
protect a different capability and have a different rotation lifecycle.

Install the selected profile's Homebrew layers, then provision the identity:

```sh
./scripts/secrets/configure-sops-age-identity.sh
```

The command is idempotent. It creates an identity only when one does not exist,
sets owner-only permissions, derives the public recipient, and proves a real
SOPS encrypt/decrypt round trip. It never prints the private identity.

SOPS' native default paths are used:

| Platform | Private identity path |
| --- | --- |
| macOS | `~/Library/Application Support/sops/age/keys.txt` |
| Linux | `~/.config/sops/age/keys.txt` |

`XDG_CONFIG_HOME` changes the config root. Set `SOPS_AGE_KEY_FILE` only when an
explicit owner-only path is required. Check an existing identity without
creating or repairing it:

```sh
./scripts/secrets/configure-sops-age-identity.sh --check
```

Print only the safe public recipient for a registry or SOPS policy:

```sh
./scripts/secrets/configure-sops-age-identity.sh --print-recipient
```

## Recovery

Generation and recovery registration are one provisioning operation. Before
using a new identity for live ciphertext:

1. Save the private identity file in an approved human-controlled recovery
   system, such as a 1Password file attachment.
2. Record the deployment name, public recipient, creation date, and local path
   with the recovery item.
3. Restore the attachment to an owner-only temporary path and run
   `age-keygen -y <restored-path>`.
4. Confirm the restored recipient exactly matches
   `configure-sops-age-identity.sh --print-recipient`.
5. Remove the temporary restored copy.

Do not print or paste the private identity into shell history, logs, issues,
pull requests, chat, or repository files. Routine unattended workloads must
not have access to the human recovery system.

## Encrypted Secret Repositories

Consumer repositories own their `.sops.yaml`, encrypted payloads, runtime
wrapper, and recipient policy. This dotfiles repo owns only the portable tools,
identity provisioning, and local verification.

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
3. Run `sops updatekeys --yes <encrypted-file>` for each affected file.
4. Prove the new deployment can decrypt its files and cannot decrypt sibling
   identity files.
5. Remove the old recipient and update the encrypted files again.
6. Rotate the underlying secrets before retiring the old deployment because
   old Git revisions remain decryptable by the old identity.
7. Remove the old local identity and archive its recovery item.
