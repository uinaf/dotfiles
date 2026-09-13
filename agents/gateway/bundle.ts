import { build } from "esbuild";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const names = ["llm-gateway-credential", "codex-gatewai", "cursor-agent-api", "cursor-acp-api-key-auth"] as const;
export type GatewayHelper = typeof names[number];

export function gatewayInterpreter(executable: string): string {
  // mise advances this symlink when Node updates; installed clients survive
  // removal of the previous version and harnesses that redirect HOME.
  const stable = executable.replace(/\/installs\/node\/[^/]+\/bin\/node$/, "/installs/node/latest/bin/node");
  return existsSync(stable) ? stable : executable;
}

export async function bundleGatewayHelpers(executable = process.execPath): Promise<Record<GatewayHelper, string>> {
  const interpreter = gatewayInterpreter(executable);
  if (/[\r\n]/.test(interpreter)) throw new Error("gateway interpreter path must not contain line breaks");
  const quotedInterpreter = `'${interpreter.replaceAll("'", "'\\''")}'`;
  // The shell exec handles whitespace in the interpreter path. Node evaluates
  // the installed bundle as CJS regardless of an ancestor package.json type.
  const launcher = `#!/bin/sh\n':' //; exec ${quotedInterpreter} --input-type=commonjs --eval 'eval(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$0" "$@"`;
  const root = resolve(import.meta.dirname, "../..");
  const result = await build({
    absWorkingDir: root,
    entryPoints: names.map((name) => `agents/gateway/${name}.ts`),
    outdir: "gateway-helpers", bundle: true, write: false,
    platform: "node", format: "cjs", target: "node24", minify: true,
    legalComments: "none", banner: { js: launcher },
  });
  const helper = (name: GatewayHelper): string => {
    const output = result.outputFiles.find((file) => file.path === join(root, "gateway-helpers", `${name}.js`));
    if (!output) throw new Error(`missing bundled gateway helper: ${name}`);
    return output.text;
  };
  return {
    "llm-gateway-credential": helper("llm-gateway-credential"),
    "codex-gatewai": helper("codex-gatewai"),
    "cursor-agent-api": helper("cursor-agent-api"),
    "cursor-acp-api-key-auth": helper("cursor-acp-api-key-auth"),
  };
}
