import { Effect, FileSystem, Option } from "effect";
import { delimiter, join } from "node:path";

// PATH lookup without spawning a shell; shared by platform and portable scripts.
export const commandAvailable = Effect.fn("commandAvailable")(function*(name: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const info = yield* fs.stat(join(directory, name)).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0) return true;
  }
  return false;
});
