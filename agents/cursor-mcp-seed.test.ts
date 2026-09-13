import assert from "node:assert/strict";
import { test } from "node:test";

import { cursorProjectSlug } from "./cursor-mcp-seed.ts";

test("matches Cursor's project directory slug", () => {
  assert.equal(cursorProjectSlug("/Users/dev/projects/acme/dotfiles"), "Users-dev-projects-acme-dotfiles");
  assert.equal(cursorProjectSlug("/Users/dev/projects/acme/site.example"), "Users-dev-projects-acme-site-dot-example");
  assert.equal(cursorProjectSlug("/private/tmp"), "private-tmp");
  assert.equal(cursorProjectSlug("/tmp"), process.platform === "darwin" ? "private-tmp" : "tmp");
});
