#!/usr/bin/env node

import { Effect } from "effect";
import { configureGateway } from "../agents/gateway/enrollment.ts";
import { runMain } from "../lib/program.ts";

const modes = [
  ["--check", "check"],
  ["--rollback", "rollback"],
  ["--setup", "setup"],
  ["--maintenance", "maintenance"],
] as const;

runMain(
  Effect.tryPromise({
    try: async () => {
      const args = process.argv.slice(2);
      const mode =
        args.length === 0
          ? "apply"
          : args.length === 1
            ? modes.find(([flag]) => flag === args[0])?.[1]
            : undefined;
      if (mode === undefined)
        throw new Error(
          "usage: configure-llm-gateway.ts [--check|--rollback|--setup|--maintenance]",
        );
      await configureGateway(mode);
    },
    catch: (error) => error,
  }),
);
