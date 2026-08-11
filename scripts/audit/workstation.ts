#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { type AuditFormat, type AuditPolicy, runPolicy } from "./engine.ts";

const homeDotfiles = { kind: "home-dotfiles", exclude: [".CFUserTextEncoding", ".DS_Store", ".localized", ".npmrc"] } as const;
const sshConfigs = { kind: "files", path: ".ssh", maxDepth: 0, namePrefix: "config" } as const;
const launchAgents = { kind: "files", path: "Library/LaunchAgents" } as const;

export const workstationPolicy = {
  name: "workstation-security",
  summary: "workstation security audit summary",
  sections: [
    {
      title: "local config file modes",
      checks: [
        { kind: "file-mode", path: ".gitconfig.local", modes: [0o600], missing: "warn", mismatch: "fail" },
        { kind: "file-mode", path: ".ssh/config.local", modes: [0o600], missing: "warn", mismatch: "fail" },
        { kind: "file-mode", path: ".codex/config.toml", modes: [0o600], missing: "warn", mismatch: "fail" },
      ],
    },
    {
      title: "local secret scan",
      checks: [
        { kind: "secret-scan", sources: [homeDotfiles, { kind: "path", path: ".aws" }, { kind: "path", path: ".docker" }, { kind: "path", path: ".bash_sessions" }, { kind: "path", path: ".zsh_sessions" }, { kind: "path", path: "Library/LaunchAgents" }, sshConfigs] },
        { kind: "npm-auth-boundary", path: ".npmrc" },
        { kind: "pattern-absent", sources: [homeDotfiles, sshConfigs, launchAgents], pattern: /op:\/\//, label: "1Password item references", severity: "warn" },
        { kind: "pattern-absent", sources: [{ kind: "path", path: ".docker/config.json" }], pattern: /"auth"\s*:/, label: "inline Docker auth material", severity: "fail" },
      ],
    },
    { title: "Git and GitHub identity", checks: [{ kind: "git-identity", config: ".gitconfig" }, { kind: "github-auth" }] },
    { title: "SSH key file permissions", checks: [{ kind: "ssh-private-key-modes", path: ".ssh" }] },
    { title: "Codex log size", checks: [{ kind: "codex-log-size", path: ".codex" }] },
    { title: "Tailscale", checks: [{ kind: "command-status", command: "tailscale", args: ["status", "--peers=false"], missing: "warn", failure: "warn", label: "tailscale status" }] },
  ],
} satisfies AuditPolicy;

export function runWorkstation(format: AuditFormat): number {
  return runPolicy(workstationPolicy, format).status;
}

function main(args: string[]): number {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "--json")) {
    process.stderr.write("Usage: scripts/audit/workstation.ts [--json]\n");
    return 2;
  }
  return runWorkstation(args[0] === "--json" ? "json" : "text");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = main(process.argv.slice(2));
