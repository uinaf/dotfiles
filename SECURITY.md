# Security

- Report vulnerabilities privately to [dev@uinaf.dev](mailto:dev@uinaf.dev).
- Include the affected file or setup step, reproduction, and impact.
- Keep secret values, keys, and private machine details out of reports and public issues.
- Use [SOPS/age provisioning and recovery](docs/identities.md) for credentials. Keep plaintext secrets out of shell startup, service definitions, and tracked or generated environment files.
- Run [security audits](docs/security-audits.md) on the intended repository or Mac; treat raw output as sensitive.
