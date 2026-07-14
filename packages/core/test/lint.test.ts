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

  it("does not join secret assignments across line breaks", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\n---\n# Concept\n\ntoken\n=\nabcdefghijklmnopqrstuvwxyz\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

      expect(codes).not.toContain("security/suspicious-secret");
      expect(codes).not.toContain("security/token-looking-value");
    });
  });

  it("checks frontmatter order with carriage-return line endings", async () => {
    await withBundle({
      "concept.md": "---\rtitle: Example\rtype: Note\r---\r# Example\r"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics.map((diagnostic) => diagnostic.code))
        .toContain("style/frontmatter-key-order");
    });
  });

  it("checks frontmatter order across valid YAML mapping styles", async () => {
    await withBundle({
      "flow.md": "---\n{title: Flow, type: Note}\n---\n# Flow\n",
      "numeric.md": "---\ntype: Note\n\"1\": custom\n---\n# Numeric key\n",
      "quoted.md": "---\n\"title\": Quoted\ntype: Note\n---\n# Quoted\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics
        .filter((diagnostic) => diagnostic.code === "style/frontmatter-key-order")
        .map((diagnostic) => diagnostic.path))
        .toEqual(["flow.md", "quoted.md"]);
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

  it("attributes circular references to concepts in the cycle", async () => {
    await withBundle({
      "a.md": "---\ntype: Note\ntitle: A\n---\n[B](b.md)\n",
      "b.md": "---\ntype: Note\ntitle: B\n---\n[C](c.md)\n",
      "c.md": "---\ntype: Note\ntitle: C\n---\n[B](b.md)\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics
        .filter((diagnostic) => diagnostic.code === "graph/circular-reference")
        .map((diagnostic) => diagnostic.path))
        .toEqual(["b.md"]);
    });
  });

  it("checks dense acyclic graphs without enumerating paths", async () => {
    const nodeCount = 32;
    const files = Object.fromEntries(Array.from({ length: nodeCount }, (_, source) => {
      const links = Array.from({ length: nodeCount - source - 1 }, (_, offset) => {
        const target = source + offset + 1;
        return `[Node ${target}](node-${target}.md)`;
      });
      return [
        `node-${source}.md`,
        `---\ntype: Note\ntitle: Node ${source}\n---\n${links.join("\n")}\n`
      ];
    }));

    await withBundle(files, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "graph/circular-reference"))
        .toBe(false);
    });
  });

  it("reports each concept once for normalized duplicate resources", async () => {
    await withBundle({
      "a.md": "---\ntype: Note\ntitle: A\nresource:\n  - ' https://example.com/shared ' \n  - https://example.com/shared\n---\n# A\n",
      "b.md": "---\ntype: Note\ntitle: B\nresource: https://EXAMPLE.com/shared\n---\n# B\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics
        .filter((diagnostic) => diagnostic.code === "hygiene/duplicate-resource")
        .map((diagnostic) => diagnostic.path))
        .toEqual(["a.md", "b.md"]);
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

  it("rejects impossible calendar dates in ISO timestamps", async () => {
    await withBundle({
      "invalid.md": "---\ntype: Note\ntitle: Invalid\ntimestamp: 2025-02-29T00:00:00Z\n---\n# Invalid\n",
      "leap.md": "---\ntype: Note\ntitle: Leap\ntimestamp: 2024-02-29T23:59:59.000Z\n---\n# Leap\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }), {
        config: { rules: { "style/timestamp-format": "warning" } }
      });

      expect(result.diagnostics
        .filter((diagnostic) => diagnostic.code === "style/timestamp-format")
        .map((diagnostic) => diagnostic.path))
        .toEqual(["invalid.md"]);
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

  it("normalizes configured resource hosts", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\ndescription: Demo\nresource: https://DOCS.Example.com./doc\n---\n# Concept\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }), {
        config: {
          resourcePolicy: {
            allowHosts: ["  Docs.Example.COM.  "]
          }
        }
      });

      expect(result.diagnostics.map((diagnostic) => diagnostic.code))
        .not.toContain("security/non-allowlisted-resource");
    });
  });

  it("matches canonical host aliases without decoding opaque URL hosts", async () => {
    await withBundle({
      "concept.md": `---
type: Note
title: Concept
resource:
  - https://éxample.com/unicode
  - s3://éxample.com/opaque-unicode
  - http://127.1/short-ipv4
  - http://[2001:db8::1]/ipv6
  - s3://local%68ost/opaque
---
# Concept
`
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }), {
        config: {
          resourcePolicy: {
            allowHosts: [
              "éxample.com",
              "127.0.0.1",
              "2001:0DB8:0:0:0:0:0:1",
              "local%68ost"
            ]
          }
        }
      });

      expect(result.diagnostics
        .filter((diagnostic) => diagnostic.code === "security/non-allowlisted-resource"))
        .toEqual([]);
    });
  });

  it("does not decode percent escapes in opaque allowlist hosts", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\nresource: s3://local%68ost/private\n---\n# Concept\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }), {
        config: { resourcePolicy: { allowHosts: ["localhost"] } }
      });

      expect(result.diagnostics.map((diagnostic) => diagnostic.code))
        .toContain("security/non-allowlisted-resource");
    });
  });

  it("ignores hostless resources when enforcing host allowlists", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\ndescription: Demo\nresource:\n  - mailto:team@example.com\n  - urn:example:runbook\n---\n# Concept\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }), {
        config: {
          resourcePolicy: {
            allowHosts: ["docs.example.com"]
          }
        }
      });

      expect(result.diagnostics.map((diagnostic) => diagnostic.code))
        .not.toContain("security/non-allowlisted-resource");
    });
  });

  it("does not report a private resource as an internal URL outside resources", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\nresource: http://localhost/runbook\n---\n# Concept\n\nPublic documentation.\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

      expect(codes).toContain("security/private-url");
      expect(codes).not.toContain("security/internal-url");
    });
  });

  it("scans case-variant resource keys as regular frontmatter", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\nResource: http://localhost/private\n---\n# Concept\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics.map((diagnostic) => diagnostic.code))
        .toContain("security/internal-url");
    });
  });

  it("classifies private IP ranges without treating numeric-looking domains as private", async () => {
    await withBundle({
      "concept.md": `---
type: Note
title: Concept
resource:
  - http://10.example.com/public
  - http://127.0.0.2/loopback
  - http://169.254.1.2/link-local
  - http://100.64.0.1/shared
  - http://[::1]/loopback
  - http://[fc00::1]/private
  - http://[fe80::1]/link-local
  - http://printer.local/admin
  - http://2130706433/integer-loopback
  - http://0x7f000001/hex-loopback
  - http://127.1/short-loopback
  - http://192.168.1/short-private
  - s3://2130706433/integer-loopback
  - s3://0x7f000001/hex-loopback
  - s3://0177.0.0.1/octal-loopback
  - s3://08/not-valid-octal
  - s3://10.example.com/public
  - http://[::ffff:127.0.0.1]/mapped-loopback
  - http://[::ffff:8.8.8.8]/mapped-public
---
# Concept
`
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));
      const messages = result.diagnostics
        .filter((diagnostic) => diagnostic.code === "security/private-url")
        .map((diagnostic) => diagnostic.message);

      expect(messages).toHaveLength(15);
      expect(messages.some((message) => message.includes("10.example.com"))).toBe(false);
      expect(messages.some((message) => message.includes("127.0.0.2"))).toBe(true);
      expect(messages.some((message) => message.includes("[fc00::1]"))).toBe(true);
      expect(messages.some((message) => message.includes("printer.local"))).toBe(true);
      expect(messages.some((message) => message.includes("2130706433"))).toBe(true);
      expect(messages.some((message) => message.includes("s3://0x7f000001"))).toBe(true);
      expect(messages.some((message) => message.includes("s3://08"))).toBe(false);
      expect(messages.some((message) => message.includes("[::ffff:8.8.8.8]"))).toBe(false);
    });
  });

  it("detects bracketed private IPv6 URLs in body text", async () => {
    await withBundle({
      "ipv6.md": "---\ntype: Note\ntitle: IPv6\n---\n# IPv6\n\nSee http://[::1]/admin.\n",
      "mapped.md": "---\ntype: Note\ntitle: Mapped\n---\n# Mapped\n\n[Local](HTTP://[::ffff:127.0.0.1]/admin)\n"
    }, async (root) => {
      const result = lintBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics
        .filter((diagnostic) => diagnostic.code === "security/internal-url")
        .map((diagnostic) => diagnostic.path))
        .toEqual(["ipv6.md", "mapped.md"]);
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

  it("contains malformed plugin metadata and diagnostics", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\n---\n# Concept\n"
    }, async (root) => {
      const result = await lintBundleWithPlugins(
        await loadBundle(root, { loadConfigFile: false }),
        {
          plugins: [{
            name: "malformed-plugin",
            source: "inline",
            options: {},
            rules: {
              "custom/bad-output": {
                run: () => [{ code: 42, message: "Bad" }] as never
              },
              "custom/bad-meta": {
                meta: { defaultSeverity: "fatal" as never },
                run: () => []
              },
              "custom/sparse-output": {
                run: () => new Array(1) as never
              },
              "custom/escaped-path": {
                run: () => [{ message: "Outside", path: "../outside.md" }]
              },
              "custom/unsafe-location": {
                run: () => [{
                  message: "Unsafe location",
                  location: { start: { line: Number.MAX_SAFE_INTEGER + 1, column: 1 } }
                }]
              },
              "custom/reversed-location": {
                run: () => [{
                  message: "Reversed location",
                  location: { start: { line: 2, column: 1 }, end: { line: 1, column: 1 } }
                }]
              }
            }
          }]
        }
      );

      const failures = result.diagnostics.filter((diagnostic) => diagnostic.code === "plugin/rule-failed");
      expect(failures).toHaveLength(6);
      expect(failures.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
        expect.stringContaining("diagnostic code must be a string"),
        expect.stringContaining("unsupported default severity"),
        expect.stringContaining("rule diagnostics must be objects"),
        expect.stringContaining("diagnostic path must be a normalized, portable relative path"),
        expect.stringContaining("diagnostic location.start.line must be a safe integer"),
        expect.stringContaining("diagnostic location end must not precede its start")
      ]));
    });
  });

  it("ignores plugin metadata and diagnostic fields inherited from prototypes", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\n---\n# Concept\n"
    }, async (root) => {
      const inheritedMetaRule = Object.assign(
        Object.create({ meta: { defaultSeverity: "error" } }),
        { run: () => [{ message: "Inherited metadata ignored." }] }
      );
      const result = await lintBundleWithPlugins(
        await loadBundle(root, { loadConfigFile: false }),
        {
          plugins: [{
            name: "prototype-plugin",
            source: "inline",
            options: {},
            rules: {
              "custom/inherited-meta": inheritedMetaRule,
              "custom/inherited-diagnostic": {
                run: () => [Object.create({ code: "forged", message: "Inherited" })]
              },
              "custom/inherited-path": {
                run: () => [Object.assign(Object.create({ path: "forged.md" }), { message: "Own" })]
              }
            }
          }]
        }
      );

      expect(result.diagnostics.find((diagnostic) => diagnostic.code === "custom/inherited-meta")?.severity)
        .toBe("warning");
      expect(result.diagnostics.find((diagnostic) => diagnostic.code === "custom/inherited-path"))
        .toEqual(expect.not.objectContaining({ path: "forged.md" }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "forged" }));
      expect(result.diagnostics.find((diagnostic) => diagnostic.code === "plugin/rule-failed")?.message)
        .toContain("diagnostic message must be a string");
    });
  });

  it("runs plugin rules whose ids match object prototype properties", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\n---\n# Concept\n"
    }, async (root) => {
      const rules = Object.fromEntries(["constructor", "__proto__"].map((id) => [id, {
        run: () => [{ message: `Rule ${id} ran.` }]
      }]));
      const result = await lintBundleWithPlugins(
        await loadBundle(root, { loadConfigFile: false }),
        {
          plugins: [{
            name: "prototype-rules",
            source: "inline",
            options: {},
            rules
          }]
        }
      );

      expect(result.diagnostics
        .filter((diagnostic) => diagnostic.code === "constructor" || diagnostic.code === "__proto__")
        .map((diagnostic) => ({ code: diagnostic.code, severity: diagnostic.severity })))
        .toEqual([
          { code: "__proto__", severity: "warning" },
          { code: "constructor", severity: "warning" }
        ]);
    });
  });
});
