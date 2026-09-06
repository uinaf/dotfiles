import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Shared T3 Code primitives for the workstation-side sync and inspection commands.

const APPLICATIONS_DIRECTORY = "/Applications";
export const exactT3Version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const sshTargetPattern = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

export function parseT3Version(input: string): string {
  const packageSpec = input.trim().replace(/^npx\s+/, "");
  const version = packageSpec.startsWith("t3@")
    ? packageSpec.slice("t3@".length)
    : packageSpec;
  if (!exactT3Version.test(version)) {
    throw new Error(`expected an exact T3 version, got: ${input}`);
  }
  return version;
}

export function selectWorkstationT3App(appNames: readonly string[]): string {
  const matches = appNames.filter((name) => /^T3 Code(?: \([^)]+\))?\.app$/.test(name));
  if (matches.includes("T3 Code.app")) return "T3 Code.app";
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error("missing T3 Code app; pass --version explicitly");
  throw new Error(`multiple T3 Code apps found; pass --version explicitly: ${matches.sort().join(", ")}`);
}

export type WorkstationT3Installation = {
  app: string;
  version: string;
};

export function workstationT3Installation(
  applicationsDirectory = APPLICATIONS_DIRECTORY,
): WorkstationT3Installation {
  const app = selectWorkstationT3App(readdirSync(applicationsDirectory));
  const plist = join(applicationsDirectory, app, "Contents/Info.plist");
  const version = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", plist],
    {encoding: "utf8"},
  );
  return {app, version: parseT3Version(version)};
}

export function workstationT3Version(applicationsDirectory = APPLICATIONS_DIRECTORY): string {
  return workstationT3Installation(applicationsDirectory).version;
}

// Client-side hardening shared by every workstation-to-devbox SSH session:
// no prompts, no forwarding or multiplexing, strict host keys, bounded
// connect and keepalive so a hung transport cannot stall an update pass.
export const sshHardeningArguments: readonly string[] = [
  "-o", "BatchMode=yes",
  "-o", "ClearAllForwardings=yes",
  "-o", "ConnectionAttempts=1",
  "-o", "ConnectTimeout=10",
  "-o", "ControlMaster=no",
  "-o", "ControlPath=none",
  "-o", "ForwardAgent=no",
  "-o", "RequestTTY=no",
  "-o", "ServerAliveCountMax=2",
  "-o", "ServerAliveInterval=5",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "UpdateHostKeys=no",
];

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
