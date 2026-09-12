#!/usr/bin/env node

// Routes the maintenance schedule commands to the platform implementation:
// launchd on macOS, a systemd user timer on Linux.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const implementation = process.platform === "darwin" ? "../darwin/maintenance/schedule.ts" : "../linux/maintenance/schedule.ts";
const result = spawnSync(process.execPath, [resolve(import.meta.dirname, implementation), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
