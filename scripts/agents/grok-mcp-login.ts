#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";
import { errorMessage } from "./runtime.ts";

const USAGE = `Usage: ./scripts/agents/grok-mcp-login.ts [--no-browser] [--port PORT] SERVER

Completes MCP OAuth (PKCE) for one HTTP server in ~/.grok/config.toml without
the Grok TUI and stores the tokens where Grok reads them. Prints the
authorization URL; with --no-browser (SSH) open it on a machine that can reach
the loopback callback port, e.g. through \`ssh -L PORT:127.0.0.1:PORT\`.`;

// Grok 1.0.25 keys ~/.grok/mcp_credentials.json by "<name>:<url>" and stores
// token_received_at in seconds. Earlier releases keyed by name or URL with
// milliseconds; both legacy keys are written so a downgrade keeps working.
type StoredCredentials = {
  client_id: string;
  issuer: string;
  token_response: Record<string, unknown>;
  granted_scopes: string[];
  token_received_at: number;
};

type Options = { server: string; port: number; browser: boolean };

function parseArgs(args: readonly string[]): Options | { error: string } | "help" {
  let server: string | undefined;
  let port = 2419;
  let browser = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--no-browser") {
      browser = false;
    } else if (arg === "--port") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) return { error: "--port requires a TCP port" };
      port = value;
      index += 1;
    } else if (arg !== undefined && !arg.startsWith("-") && server === undefined) {
      server = arg;
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }
  if (server === undefined) return { error: "SERVER is required" };
  return { server, port, browser };
}

export function serverUrlFromConfig(toml: string, server: string): string | undefined {
  const lines = toml.split(/\r?\n/);
  const header = new RegExp(`^\\[mcp_servers\\.(?:"${server}"|${server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\]\\s*$`);
  const start = lines.findIndex((line) => header.test(line.trim()));
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("[")) break;
    const match = /^\s*url\s*=\s*"([^"]+)"/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

type Metadata = { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; issuer: string };

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  if (typeof body !== "object" || body === null) throw new Error(`${url} returned a non-object`);
  return body as Record<string, unknown>;
}

async function discover(serverUrl: string): Promise<Metadata> {
  const origin = new URL(serverUrl).origin;
  const resource: Record<string, unknown> = await fetchJson(`${origin}/.well-known/oauth-protected-resource`).catch(() => ({}));
  const issuers = Array.isArray(resource.authorization_servers) ? resource.authorization_servers : [origin];
  const issuer = typeof issuers[0] === "string" ? issuers[0] : origin;
  const meta = await fetchJson(`${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    if (typeof meta[key] !== "string") throw new Error(`OAuth metadata is missing ${key}`);
  }
  return { ...(meta as Metadata), issuer };
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

export function writeCredentials(path: string, server: string, serverUrl: string, entry: StoredCredentials): void {
  const existing: Record<string, unknown> = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  existing[`${server}:${serverUrl}`] = entry;
  const legacy = { ...entry, token_received_at: entry.token_received_at * 1000 };
  existing[server] = legacy;
  existing[serverUrl] = legacy;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

async function login(options: Options): Promise<void> {
  const home = process.env.GROK_HOME ?? join(homedir(), ".grok");
  const configPath = join(home, "config.toml");
  if (!existsSync(configPath)) throw new Error(`${configPath} does not exist`);
  const serverUrl = serverUrlFromConfig(readFileSync(configPath, "utf8"), options.server);
  if (serverUrl === undefined) throw new Error(`${options.server} has no url in ${configPath}`);

  const meta = await discover(serverUrl);
  const redirect = `http://127.0.0.1:${options.port}/callback`;
  const registration = await fetchJson(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "grok-cli",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const clientId = registration.client_id;
  if (typeof clientId !== "string") throw new Error("client registration returned no client_id");

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(16).toString("hex");
  const scope = "openid profile email offline_access";
  const authorizeUrl = new URL(meta.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: redirect,
    state,
    scope,
    prompt: "consent",
    resource: `${new URL(serverUrl).origin}/`,
  })) {
    authorizeUrl.searchParams.set(key, value);
  }

  const code = await new Promise<string>((resolvePromise, rejectPromise) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", redirect);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain" }).end("Grok MCP login complete. You can close this tab.");
      server.close();
      clearTimeout(timer);
      if (url.searchParams.get("state") !== state) {
        rejectPromise(new Error("OAuth state mismatch"));
        return;
      }
      const value = url.searchParams.get("code");
      value ? resolvePromise(value) : rejectPromise(new Error(url.searchParams.get("error_description") ?? "no authorization code"));
    });
    const timer = setTimeout(() => {
      server.close();
      rejectPromise(new Error("timed out waiting for the browser authorization"));
    }, 10 * 60 * 1000);
    server.once("error", rejectPromise);
    server.listen(options.port, "127.0.0.1", () => {
      process.stdout.write(`Authorize in your browser:\n${authorizeUrl}\n`);
      if (options.browser && process.platform === "darwin") {
        import("node:child_process").then(({ spawn }) => spawn("open", [authorizeUrl.toString()], { stdio: "ignore" }).unref());
      }
    });
  });

  const tokens = await fetchJson(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }).toString(),
  });
  if (typeof tokens.access_token !== "string") throw new Error("token exchange returned no access_token");

  writeCredentials(join(home, "mcp_credentials.json"), options.server, serverUrl, {
    client_id: clientId,
    issuer: meta.issuer,
    token_response: tokens,
    granted_scopes: (typeof tokens.scope === "string" ? tokens.scope : scope).split(" "),
    token_received_at: Math.floor(Date.now() / 1000),
  });
  process.stdout.write(`Stored Grok MCP credentials for ${options.server}. Verify with: grok mcp doctor\n`);
}

const program = Effect.gen(function*() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if ("error" in parsed) {
    process.stderr.write(`${USAGE}\n${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  yield* Effect.tryPromise({ try: () => login(parsed), catch: (error) => new Error(`Grok MCP login failed: ${errorMessage(error)}`) });
});

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runMain(program);
}
