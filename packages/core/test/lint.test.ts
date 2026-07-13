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
      expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "graph/circular-reference"))
        .toHaveLength(1);
    });
  });

  it("reports high-degree graph hubs", async () => {
    const leafFiles = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [
      `leaf-${index}.md`,
      `---\ntype: Note\ntitle: Leaf ${index}\n---\n# Leaf ${index}\n`
    ]));
    const links = Array.from({ length: 25 }, (_, index) => `[Leaf ${index}](leaf-${index}.md)`).join("\n");

    await withBundle({
      "hub.md": `---\ntype: Note\ntitle: Hub\n---\n${links}\n`,
      ...leafFiles
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("graph/high-degree-hub");
    });
  });

  it("counts repeated links as one graph neighbor", async () => {
    const repeatedLinks = Array.from({ length: 25 }, () => "[Target](target.md)").join("\n");
    await withBundle({
      "source.md": `---\ntype: Note\ntitle: Source\n---\n${repeatedLinks}\n`,
      "target.md": "---\ntype: Note\ntitle: Target\n---\n# Target\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("graph/high-degree-hub");
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

  it("runs agent readiness rules only when configured and honors their severity", async () => {
    await withBundle({
      "metric.md": "---\ntype: Metric\ntitle: Metric\n---\n# Metric\n"
    }, async (root) => {
      const bundle = await loadBundle(root, { loadConfigFile: false });
      const defaultResult = lintBundle(bundle);
      const agentResult = lintBundle(bundle, {
        config: {
          presets: ["agent-ready"],
          rules: {
            "agent/missing-owner": "error"
          }
        }
      });

      expect(defaultResult.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("agent/missing-owner");
      expect(agentResult.diagnostics.find((diagnostic) => diagnostic.code === "agent/missing-owner")?.severity).toBe("error");
      expect(agentResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("agent/metric-missing-source");
    });
  });

  it("applies rule overrides to validation diagnostics", async () => {
    await withBundle({
      "concept.md": "---\ntitle: Concept\n---\n# Concept\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }), {
        config: {
          rules: {
            "spec/missing-type": "off"
          }
        }
      });

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("spec/missing-type");
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
