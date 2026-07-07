import { describe, expect, it } from "vitest";

import { loadBundle, validateBundle } from "../src/index.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function withBundle(files: Record<string, string>, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "okfx-validate-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(root, path);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("validateBundle", () => {
  it("passes valid concepts", async () => {
    await withBundle({
      "concepts/example.md": "---\ntype: Note\n---\n# Example\n"
    }, async (root) => {
      const result = validateBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.ok).toBe(true);
      expect(result.counts.error).toBe(0);
      expect(result.diagnostics).toEqual([]);
    });
  });

  it("reports missing frontmatter", async () => {
    await withBundle({
      "concepts/example.md": "# Example\n"
    }, async (root) => {
      const result = validateBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]).toMatchObject({
        code: "spec/missing-frontmatter",
        severity: "error",
        path: "concepts/example.md"
      });
    });
  });

  it("reports missing type", async () => {
    await withBundle({
      "concepts/example.md": "---\ntitle: Example\n---\n# Example\n"
    }, async (root) => {
      const result = validateBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]).toMatchObject({
        code: "spec/missing-type",
        severity: "error",
        path: "concepts/example.md"
      });
    });
  });

  it("keeps parser diagnostics as validation errors", async () => {
    await withBundle({
      "concepts/example.md": "---\ntype: [\n---\n# Example\n"
    }, async (root) => {
      const result = validateBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["spec/invalid-frontmatter"]);
    });
  });

  it("reports unsupported OKF versions", async () => {
    await withBundle({
      "concepts/example.md": "---\ntype: Note\n---\n# Example\n"
    }, async (root) => {
      const result = validateBundle(await loadBundle(root, {
        loadConfigFile: false,
        config: {
          okfVersion: "9.9"
        }
      }));

      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]).toMatchObject({
        code: "spec/unsupported-okf-version",
        severity: "error"
      });
    });
  });
});
