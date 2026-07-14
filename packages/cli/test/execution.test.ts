import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { identifiesFile } from "../src/execution.js";

describe("CLI execution detection", () => {
  it("treats missing argv entries as imports", () => {
    const currentFile = fileURLToPath(import.meta.url);
    expect(identifiesFile(undefined, currentFile)).toBe(false);
    expect(identifiesFile("-", currentFile)).toBe(false);
  });

  it("recognizes a symlink to the executed module", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-cli-execution-"));
    const target = join(root, "target.mjs");
    const link = join(root, "link.mjs");
    try {
      await writeFile(target, "", "utf8");
      await symlink(target, link, "file");

      expect(identifiesFile(link, target)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
