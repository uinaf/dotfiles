import { Effect } from "effect";
import { dirname, resolve } from "node:path";
import { CommandRunner } from "../../lib/command.ts";
import { failure, main, readGateway, replaceProcess } from "./gateway-runtime.ts";

main(
  Effect.gen(function* () {
    const home = resolve(dirname(resolve(process.argv[1])), "../../..");
    const { config } = yield* readGateway(home);
    if (!config.grokBin) return yield* failure("Grok is not configured for the gateway");
    const args = process.argv.slice(2);
    if (args.length !== 1 || args[0] !== "models")
      return yield* replaceProcess(config.grokBin, args);

    const runner = yield* CommandRunner;
    const result = yield* runner.run(config.grokBin, args);
    // Grok prints cached auth status before model discovery refreshes an expired
    // external credential. T3 treats that stale banner as a login failure.
    if (result.status === 0 && /^You are not authenticated\.\s*$/m.test(result.stdout))
      return yield* replaceProcess(config.grokBin, args);

    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status;
  }).pipe(Effect.provide(CommandRunner.layer)),
);
