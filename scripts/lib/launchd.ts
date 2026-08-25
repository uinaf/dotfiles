import { Effect, FileSystem, Option } from "effect";
import { basename } from "node:path";
import { fail } from "./program.ts";

const component = /^[A-Za-z0-9._-]+$/;
const exactVersion = /^[A-Za-z0-9._+-]+$/;

export function resolveLaunchdNamespace(requested = ""): string {
  const namespace = requested || process.env.DOTFILES_LAUNCHD_NAMESPACE || "local.dotfiles";
  if (!component.test(namespace) || namespace.startsWith(".") || namespace.endsWith(".") || namespace.includes("..")) {
    throw new Error("LaunchDaemon namespace must contain dot-separated letters, numbers, hyphens, or underscores");
  }
  return namespace;
}

export function launchdLabel(service: string, user: string, namespace = ""): string {
  if (!service || !component.test(service)) throw new Error("invalid LaunchDaemon service");
  if (!user || !component.test(user)) throw new Error("invalid LaunchDaemon user");
  return `${resolveLaunchdNamespace(namespace)}.${service}.${user}`;
}

export function openclawRestartSudoersRule(user: string, label: string): string {
  if (!user || !component.test(user)) throw new Error("invalid sudoers user");
  if (!label || !component.test(label)) throw new Error("invalid sudoers label");
  return `${user} ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/${label}`;
}

export function openclawRestartSudoersName(user: string, uid: number): string {
  if (!user || !component.test(user)) throw new Error("invalid sudoers user");
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("invalid sudoers UID");
  return `dotfiles-openclaw-restart-${user.replaceAll(".", "_")}-${uid}`;
}

export function validateT3Version(version: string): boolean {
  return exactVersion.test(version);
}

export function parsePendingInstallScripts(input: string, approved: ReadonlySet<string>): readonly string[] {
  const value: unknown = JSON.parse(input);
  if (typeof value !== "object" || value === null || !("allowScripts" in value) || !Array.isArray(value.allowScripts)) {
    throw new Error("npm returned an invalid allowScripts list");
  }
  const names = [...new Set(value.allowScripts.map((entry) =>
    typeof entry === "object" && entry !== null && "name" in entry ? entry.name : undefined,
  ))];
  if (names.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error("npm returned an invalid install-script package name");
  }
  const typed = names as string[];
  const unexpected = typed.filter((name) => !approved.has(name));
  if (unexpected.length > 0) throw new Error(`unexpected T3 install scripts: ${unexpected.join(", ")}`);
  return typed;
}

export const resolveLaunchdNamespaceContract = Effect.fn("resolveLaunchdNamespaceContract")(function*(
  requested: string,
  namespaceFile: string,
  expectedUid?: number,
) {
  let requestedNamespace = "";
  if (requested) {
    requestedNamespace = yield* Effect.try({ try: () => resolveLaunchdNamespace(requested), catch: (error) => error });
  }
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(namespaceFile);
  const link = yield* fs.readLink(namespaceFile).pipe(Effect.option);
  if (exists || Option.isSome(link)) {
    if (Option.isSome(link)) return yield* fail(`unsafe stored LaunchDaemon namespace: ${namespaceFile}`);
    const info = yield* fs.stat(namespaceFile);
    if (info.type !== "File" || (info.mode & 0o777) !== 0o600) {
      return yield* fail(`unsafe stored LaunchDaemon namespace: ${namespaceFile}`);
    }
    if (expectedUid !== undefined && Option.getOrUndefined(info.uid) !== expectedUid) {
      return yield* fail(`unsafe stored LaunchDaemon namespace owner: ${namespaceFile}`);
    }
    const contents = yield* fs.readFileString(namespaceFile);
    if (!/^[^\r\n]+(?:\r?\n)?$/.test(contents)) return yield* fail(`invalid stored LaunchDaemon namespace: ${namespaceFile}`);
    const stored = yield* Effect.try({ try: () => resolveLaunchdNamespace(contents.trim()), catch: (error) => error });
    if (requestedNamespace && requestedNamespace !== stored) {
      return yield* fail("LaunchDaemon namespace differs from the stored host contract", 3);
    }
    return stored;
  }
  return yield* Effect.try({ try: () => resolveLaunchdNamespace(requestedNamespace), catch: (error) => error });
});

export function plistXml(options: {
  label: string;
  user: string;
  group: string;
  workingDirectory: string;
  stdout: string;
  stderr: string;
  arguments: readonly string[];
  keepAlive?: boolean;
  processType?: string;
  environment?: Readonly<Record<string, string>>;
}): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const item = (key: string, value: string) => `    <key>${key}</key>\n    <string>${escape(value)}</string>`;
  const args = options.arguments.map((argument) => `      <string>${escape(argument)}</string>`).join("\n");
  const environment = options.environment
    ? `\n    <key>EnvironmentVariables</key>\n    <dict>\n${Object.entries(options.environment).map(([key, value]) => `      <key>${escape(key)}</key>\n      <string>${escape(value)}</string>`).join("\n")}\n    </dict>`
    : "";
  const processType = options.processType ? `\n${item("ProcessType", options.processType)}` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
${item("Label", options.label)}
${item("UserName", options.user)}
${item("GroupName", options.group)}
${item("WorkingDirectory", options.workingDirectory)}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <${options.keepAlive === false ? "false" : "true"}/>
    <key>SessionCreate</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>Umask</key>
    <integer>63</integer>
${item("StandardOutPath", options.stdout)}
${item("StandardErrorPath", options.stderr)}
    <key>ProgramArguments</key>
    <array>
${args}
    </array>${processType}${environment}
  </dict>
</plist>
`;
}

export function plistLabelFromPath(path: string): string {
  return basename(path, ".plist");
}
