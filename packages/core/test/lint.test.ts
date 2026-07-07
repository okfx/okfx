import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { lintBundle, lintBundleWithPlugins, loadBundle } from "../src/index.js";

async function withBundle(files: Record<string, string>, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "okfx-lint-"));
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

describe("lintBundle", () => {
  it("reports hygiene, graph, style, and security diagnostics", async () => {
    await withBundle({
      "Bad Name.md": `---
description: Missing title and unordered keys.
type: Note
tags:
  - Bad Tag
timestamp: yesterday
resource: http://localhost/runbook
---

[Missing](missing.md)

Contact admin@corp.com and see http://10.0.0.5/runbook.
api_key = abcdefghijklmnopqrstuvwxyz
-----BEGIN PRIVATE KEY-----
`
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

      expect(codes).toContain("hygiene/missing-title");
      expect(codes).toContain("graph/broken-internal-link");
      expect(codes).toContain("style/frontmatter-key-order");
      expect(codes).toContain("style/timestamp-format");
      expect(codes).toContain("style/tag-format");
      expect(codes).toContain("style/file-name-format");
      expect(codes).toContain("security/private-url");
      expect(codes).toContain("security/suspicious-secret");
      expect(codes).toContain("security/private-key");
      expect(codes).toContain("security/token-looking-value");
      expect(codes).toContain("security/unredacted-email");
      expect(codes).toContain("security/internal-url");
      expect(result.ok).toBe(false);
    });
  });

  it("detects duplicates and circular references", async () => {
    await withBundle({
      "a.md": "---\ntype: Note\ntitle: Shared\nresource: https://example.com/shared\n---\n[A](b.md)\n",
      "b.md": "---\ntype: Note\ntitle: Shared\nresource: https://example.com/shared\n---\n[B](a.md)\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

      expect(codes).toContain("hygiene/duplicate-title");
      expect(codes).toContain("hygiene/duplicate-resource");
      expect(codes).toContain("graph/circular-reference");
    });
  });

  it("honors rule overrides and fail thresholds", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\n---\n# Concept\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }), {
        config: {
          failOn: "warning",
          rules: {
            "hygiene/missing-description": "off"
          }
        }
      });

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("hygiene/missing-description");
      expect(result.ok).toBe(false);
    });
  });

  it("enforces resource allowlists when configured", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\ndescription: Demo\nresource: https://bad.example.com/doc\n---\n# Concept\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }), {
        config: {
          resourcePolicy: {
            allowHosts: ["docs.example.com"]
          }
        }
      });

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("security/non-allowlisted-resource");
    });
  });

  it("runs configured plugin rules and honors rule overrides", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\n---\n# Concept\n"
    }, async (root) => {
      const bundle = await loadBundle(root, { loadConfigFile: false });
      const result = await lintBundleWithPlugins(bundle, {
        config: {
          rules: {
            "custom/owner-required": "error"
          }
        },
        plugins: [{
          name: "custom-plugin",
          source: "inline",
          options: {},
          rules: {
            "custom/owner-required": {
              meta: {
                description: "Concepts must declare an owner.",
                defaultSeverity: "warning"
              },
              run: ({ bundle: pluginBundle }) => pluginBundle.concepts
                .filter((concept) => typeof concept.frontmatter.owner !== "string")
                .map((concept) => ({
                  code: "custom/owner-required",
                  severity: "warning",
                  message: "Concept should declare an owner.",
                  path: concept.path,
                  conceptId: concept.id
                }))
            }
          }
        }]
      });

      const diagnostic = result.diagnostics.find((entry) => entry.code === "custom/owner-required");
      expect(diagnostic?.severity).toBe("error");
      expect(result.plugins).toEqual([{
        name: "custom-plugin",
        source: "inline",
        version: undefined,
        ruleCount: 1
      }]);
      expect(result.ok).toBe(false);
    });
  });
});
