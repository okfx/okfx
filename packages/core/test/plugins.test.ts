import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { loadConfiguredPlugins, resolveConfig } from "../src/index.js";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "okfx-plugins-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

describe("loadConfiguredPlugins", () => {
  it("loads explicit local plugin modules", async () => {
    await withRoot(async (root) => {
      await write(root, "okfx.config.ts", "export default {};\n");
      await write(root, "local-plugin.ts", `export default {
  name: "local-plugin",
  version: "0.1.0",
  rules: {
    "local/owner-required": {
      meta: {
        description: "Concepts must declare an owner.",
        defaultSeverity: "warning"
      },
      run() {
        return [];
      }
    }
  }
};
`);
      const config = resolveConfig({
        plugins: [{
          package: "./local-plugin.ts",
          options: {
            requiredOwner: "data-platform"
          }
        }]
      }, join(root, "okfx.config.ts"));

      const result = await loadConfiguredPlugins(root, config);

      expect(result.diagnostics).toEqual([]);
      expect(result.plugins[0]).toMatchObject({
        name: "local-plugin",
        source: "./local-plugin.ts",
        version: "0.1.0",
        options: {
          requiredOwner: "data-platform"
        }
      });
      expect(Object.keys(result.plugins[0]?.rules ?? {})).toEqual(["local/owner-required"]);
    });
  });

  it("reports load failures as diagnostics and honors disabled plugins", async () => {
    await withRoot(async (root) => {
      await write(root, "okfx.config.ts", "export default {};\n");
      const config = resolveConfig({
        plugins: [
          "./missing-plugin.ts",
          {
            package: "./disabled-plugin.ts",
            enabled: false
          }
        ]
      }, join(root, "okfx.config.ts"));

      const result = await loadConfiguredPlugins(root, config);

      expect(result.plugins).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        code: "plugin/load-failed",
        severity: "error",
        path: "./missing-plugin.ts"
      });
    });
  });
});
