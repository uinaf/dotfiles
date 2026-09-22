#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const implementation =
  process.platform === "darwin" ? "./darwin/schedule.ts" : "./linux/schedule.ts";
const result = spawnSync(
  process.execPath,
  [resolve(import.meta.dirname, implementation), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
