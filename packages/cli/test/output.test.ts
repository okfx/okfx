import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { writeOutput } from "../src/output.js";
import type { CliIO } from "../src/program.js";

const io: CliIO = {
  stdout: { write: () => true },
  stderr: { write: () => true }
};

describe("writeOutput", () => {
  it("refuses to overwrite a symbolic link target", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-output-"));
    const external = join(root, "external.json");
    const out = join(root, "result.json");
    try {
      await writeFile(external, "sentinel", "utf8");
      await symlink(external, out, "file");

      await expect(writeOutput("changed", out, io)).rejects.toThrow("symbolic link");
      expect(await readFile(external, "utf8")).toBe("sentinel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
