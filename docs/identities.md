# Identity Provisioning

Provision credentials per Unix user and host. Keep age, SSH, GitHub, and provider
credentials independently replaceable; profiles select software, not access.

All developer profiles require explicit Git authorship and local SSH signing.
Every profile except `developer` and `workstation` requires a SOPS age
identity; those two need one when they consume encrypted secrets.

## Developer Git and SSH

Provide an owner-only, unencrypted local SSH private key for unattended signing.
Export recovery keys in OpenSSH format without a passphrase and save them
outside this repository:

```zsh
chmod 0600 ~/.ssh/developer_ed25519
ssh-keygen -y -f ~/.ssh/developer_ed25519 > ~/.ssh/developer_ed25519.pub
chmod 0644 ~/.ssh/developer_ed25519.pub
```

Use explicit operator values:

```zsh
profile=workstation
GIT_USER_NAME='Developer Name' \
GIT_USER_EMAIL='developer@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/developer_ed25519" \
GIT_SSH_IDENTITY_FILE="$HOME/.ssh/developer_ed25519" \
  ./scripts/bootstrap/configure-git.ts --profile "$profile" --non-interactive
```

- Authentication may use a different key through `GIT_SSH_IDENTITY_FILE`.
- Register public keys with GitHub separately for authentication and signing.
- Authorship and signing go in `~/.gitconfig.local`; the managed GitHub SSH block
  goes in `~/.ssh/github.config` and disables ambient agent identities.
- Keep unrelated SSH directives in `~/.ssh/config.local`. Move aside conflicting
  `Host github.com` blocks or an unmanaged `~/.ssh/github.config` before setup.
- Inbound SSH needs the administrator's public key in `authorized_keys`, not a
  private key on the target user.

## SOPS Age Identity

An age **identity** is the private decryption key; its public address is the
**recipient**. After installing the profile's Homebrew packages:

```zsh
./scripts/secrets/configure-sops-age-identity.ts
./scripts/secrets/configure-sops-age-identity.ts --check
./scripts/secrets/configure-sops-age-identity.ts --print-recipient
```

- Provisioning creates a missing key and proves a SOPS round trip.
- Identity file: `0600`; parent directory: `0700`.
- `--check` makes no changes; `--print-recipient` outputs only the public recipient.

| Platform | Default identity path |
| --- | --- |
| macOS | `~/Library/Application Support/sops/age/keys.txt` |
| Linux | `~/.config/sops/age/keys.txt` |

`XDG_CONFIG_HOME` changes the config root; `SOPS_AGE_KEY_FILE` selects an explicit
owner-only file. Keep the [sudo identity](devbox.md#sudo-without-a-plaintext-password-file)
separate from this general identity.

Before protecting live ciphertext:

1. [Back up and verify recovery](#back-up-and-verify-recovery).
2. Give the encrypted repository owner only the public `age1...` recipient.
3. Add it to that repository's `.sops.yaml` and run `sops updatekeys` on each
   affected encrypted file.
4. Prove the deployment can decrypt its authorized payloads.

Git access permits fetching ciphertext; the recipient policy permits decryption.

## Back Up and Verify Recovery

Keep one human-controlled recovery item per deployment, with separately labeled
attachments for the general age identity, any sudo age identity, SSH key, and
applicable account recovery material. Record public recipients, creation dates,
and local paths. Unattended workloads must not access the recovery system.

Before using a new age identity:

1. Attach its private identity file to the recovery item.
2. Restore the attachment to an owner-only temporary path.
3. Run `age-keygen -y /path/to/restored-keys.txt` and compare the recipient with
   `./scripts/secrets/configure-sops-age-identity.ts --print-recipient`.
4. Verify other attachments against their own live source or public identity.
5. Remove restored temporary copies.

Keep private keys, tokens, and decrypted files out of Git, logs, shell history,
chat, and issue or pull-request bodies. Store files as attachments rather than
pasting private values into recovery notes.

## Encrypted Secret Repositories

Each consumer owns its `.sops.yaml`, encrypted payloads, wrappers, and recipient
policy. Dotfiles supplies tools and local identity verification. The optional
[SOPS vault template](https://github.com/uinaf/sops-vault-template) is a starting
point for a private vault: replace its example recipients and run its
`mise run verify` before use.

Prefer a separate provider credential per identity. Shared credentials need an
explicit recipient set and human recovery recipient. Public recipients,
fingerprints, Git authorship, GitHub App IDs, and ciphertext may be tracked;
private keys, provider tokens, plaintext env files, and private recovery-item
references may not.

## Move or Retire a Deployment

Create a new age identity for a new host:

1. Provision and verify its recovery copy.
2. Add the new recipient to the owning `.sops.yaml`.
3. Run `sops updatekeys --yes path/to/secrets.sops.yaml` for affected files.
4. Prove access to its own payloads and exclusion from sibling identities' files.
5. Remove the old recipient and update the encrypted files again.
6. Rotate underlying secrets: old Git revisions remain decryptable by the old key.
7. Remove the retired local identity and archive its recovery item.
