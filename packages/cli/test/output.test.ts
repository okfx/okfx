import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { formatDiagnosticGroups, writeOutput } from "../src/output.js";
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

  it("groups large diagnostic sets without repeated array copies", () => {
    const count = 40_000;
    const diagnostics = Array.from({ length: count }, (_, index) => ({
      code: `test/${index}`,
      severity: "warning" as const,
      message: "message",
      path: "concept.md"
    }));
    const started = performance.now();

    const formatted = formatDiagnosticGroups(diagnostics);
    const elapsedMs = performance.now() - started;

    expect(formatted.match(/test\//g)).toHaveLength(count);
    expect(elapsedMs).toBeLessThan(1000);
  }, 5000);

  it("keeps diagnostic fields on their structural output lines", () => {
    const formatted = formatDiagnosticGroups([{
      code: "test/injected\n::group::code",
      severity: "error",
      message: "message\r\n::add-mask::secret\tend",
      path: "concept.md\n::warning::path"
    }]);

    expect(formatted).not.toMatch(/[\r\t]/u);
    expect(formatted).not.toContain("\n::");
    expect(formatted).toContain("test/injected\\n::group::code");
    expect(formatted).toContain("concept.md\\n::warning::path");
    expect(formatted).toContain("message\\r\\n::add-mask::secret\\tend");
  });
});
