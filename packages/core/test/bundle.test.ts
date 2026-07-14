import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { findConfigFile, loadBundle, mergeConfig, parseMarkdownDocument, resolveConfig } from "../src/index.js";

const roots: string[] = [];

async function tempBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "okfx-"));
  roots.push(root);
  return root;
}

async function write(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadBundle", () => {
  it("ignores inherited frontmatter fields", async () => {
    const root = await tempBundle();
    await write(root, "concept.md", "---\ntitle: Concept\n---\n# Concept\n");
    Object.defineProperty(Object.prototype, "type", {
      configurable: true,
      value: "Inherited",
      writable: true
    });

    const bundle = await (async () => {
      try {
        return await loadBundle(root, { loadConfigFile: false });
      } finally {
        delete (Object.prototype as Record<string, unknown>).type;
      }
    })();

    expect(bundle.concepts[0]?.type).toBe("");
  });

  it("rejects missing roots and roots that are not directories", async () => {
    const root = await tempBundle();
    const file = join(root, "bundle.md");
    await writeFile(file, "# Not a directory\n", "utf8");

    await expect(loadBundle(join(root, "missing"), { loadConfigFile: false }))
      .rejects.toThrow("OKF bundle root does not exist");
    await expect(loadBundle(file, { loadConfigFile: false }))
      .rejects.toThrow("OKF bundle root is not a directory");
  });

  it("loads concepts, reserved files, links, and stable stats", async () => {
    const root = await tempBundle();
    await write(root, "index.md", "# Index\n\nSee [WAU](concepts/wau.md).\n");
    await write(root, "log.md", "# Log\n");
    await write(
      root,
      "concepts/wau.md",
      `---
type: Metric
title: Weekly Active Users
description: Users active in the last 7 days.
tags:
  - analytics
timestamp: 2026-07-07T00:00:00Z
---

# Weekly Active Users

See [User Events](../tables/user_events.md), [local notes](#notes), and [docs](https://example.com).

## Notes
`
    );
    await write(
      root,
      "tables/user_events.md",
      `---
type: Table
title: User Events
---

# User Events
`
    );

    const bundle = await loadBundle(root, { loadConfigFile: false });

    expect(bundle.stats).toMatchObject({
      fileCount: 4,
      conceptCount: 2,
      indexCount: 1,
      logCount: 1,
      linkCount: 4,
      brokenLinkCount: 0
    });
    expect(bundle.concepts.map((concept) => concept.id)).toEqual(["concepts/wau", "tables/user_events"]);
    expect(bundle.concepts[0]).toMatchObject({
      type: "Metric",
      title: "Weekly Active Users",
      description: "Users active in the last 7 days.",
      tags: ["analytics"],
      timestamp: "2026-07-07T00:00:00Z"
    });
    expect(bundle.links.filter((link) => link.kind === "internal").map((link) => link.targetConceptId).sort()).toEqual([
      "concepts/wau",
      "tables/user_events"
    ]);
    expect(bundle.links.every((link) => link.resolved)).toBe(true);
    expect(bundle.concepts[0]?.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("keeps broken internal links unresolved", async () => {
    const root = await tempBundle();
    await write(
      root,
      "concepts/wau.md",
      `---
type: Metric
---

[Missing](../tables/missing.md)
`
    );

    const bundle = await loadBundle(root, { loadConfigFile: false });

    expect(bundle.stats.brokenLinkCount).toBe(1);
    expect(bundle.links[0]).toMatchObject({
      kind: "internal",
      resolved: false,
      targetConceptId: undefined
    });
  });

  it("resolves links to reserved index and log files", async () => {
    const root = await tempBundle();
    await write(root, "index.md", "# Index\n\n[Concept](concept.md)\n");
    await write(root, "log.md", "# Log\n\n[Index](index.md)\n");
    await write(root, "concept.md", "---\ntype: Note\ntitle: Concept\n---\n[Log](log.md)\n");

    const bundle = await loadBundle(root, { loadConfigFile: false });

    expect(bundle.stats.brokenLinkCount).toBe(0);
    expect(bundle.links.map((link) => link.targetConceptId).sort()).toEqual(["concept", "index", "log"]);
    expect(bundle.links.every((link) => link.resolved)).toBe(true);
  });

  it("applies include and exclude globs", async () => {
    const root = await tempBundle();
    await write(root, "knowledge/kept.md", "---\ntype: Note\n---\n# Kept\n");
    await write(root, "knowledge/draft.skip.md", "---\ntype: Note\n---\n# Draft\n");
    await write(root, "other/out.md", "---\ntype: Note\n---\n# Out\n");

    const bundle = await loadBundle(root, {
      loadConfigFile: false,
      config: {
        include: ["knowledge/**/*.md"],
        exclude: ["**/*.skip.md"]
      }
    });

    expect(bundle.concepts.map((concept) => concept.path)).toEqual(["knowledge/kept.md"]);
  });

  it("rejects include globs that discover files outside the bundle root", async () => {
    const root = await tempBundle();
    const outside = join(root, "..", `okfx-outside-${Date.now()}.md`);
    try {
      await writeFile(outside, "---\ntype: Note\n---\n# Outside\n", "utf8");

      await expect(loadBundle(root, {
        loadConfigFile: false,
        config: { include: [outside] }
      })).rejects.toThrow("escapes the OKF bundle root");
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("rejects POSIX filenames with literal backslashes before reading them", async () => {
    if (sep === "\\") {
      return;
    }
    const root = await tempBundle();
    await write(root, "evil\\name.md", "---\ntype: Note\n---\n# Evil\n");

    await expect(loadBundle(root, { loadConfigFile: false }))
      .rejects.toThrow("non-portable backslash");
  });

  it("loads okfx.config.ts files", async () => {
    const root = await tempBundle();
    await write(
      root,
      "okfx.config.ts",
      `export default {
  include: ["knowledge/**/*.md"],
  exclude: ["**/ignored.md"],
  okfVersion: "0.1"
};
`
    );
    await write(root, "knowledge/kept.md", "---\ntype: Note\n---\n# Kept\n");
    await write(root, "knowledge/ignored.md", "---\ntype: Note\n---\n# Ignored\n");

    const bundle = await loadBundle(root);

    expect(bundle.okfVersion).toBe("0.1");
    expect(bundle.concepts.map((concept) => concept.path)).toEqual(["knowledge/kept.md"]);
  });

  it("preserves config file OKF version unless explicitly overridden", async () => {
    const root = await tempBundle();
    await write(root, "okfx.config.ts", "export default { okfVersion: '9.9' };\n");
    await write(root, "concept.md", "---\ntype: Note\n---\n# Concept\n");

    const configured = await loadBundle(root);
    const overridden = await loadBundle(root, {
      config: {
        okfVersion: "0.1"
      }
    });

    expect(configured.okfVersion).toBe("9.9");
    expect(overridden.okfVersion).toBe("0.1");
  });
});

describe("parseMarkdownDocument", () => {
  it("reports invalid YAML frontmatter", () => {
    const parsed = parseMarkdownDocument("concepts/bad.md", "---\ntype: [\n---\n# Bad\n", "concepts/bad");

    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      code: "spec/invalid-frontmatter",
      severity: "error",
      path: "concepts/bad.md"
    });
  });

  it.each(["1: one", "[a, b]: sequence", "metadata: {1: one}", "metadata: !!omap [{1: one}]"])(
    "rejects non-string frontmatter key %j",
    (entry) => {
      const parsed = parseMarkdownDocument(
        "concepts/bad.md",
        `---\n${entry}\n---\n# Bad\n`,
        "concepts/bad"
      );

      expect(parsed.frontmatter).toBeUndefined();
      expect(parsed.diagnostics[0]).toMatchObject({
        code: "spec/invalid-frontmatter",
        message: "Frontmatter keys must be strings."
      });
    }
  );

  it.each([".nan", ".inf", "-.inf"])("rejects non-finite frontmatter number %s", (value) => {
    const parsed = parseMarkdownDocument(
      "concepts/bad.md",
      `---\nmetadata: [${value}]\n---\n# Bad\n`,
      "concepts/bad"
    );

    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.diagnostics[0]).toMatchObject({
      code: "spec/invalid-frontmatter",
      message: "Frontmatter numbers must be finite."
    });
  });

  it("normalizes YAML tags into the same JSON representation as native parsers", () => {
    const parsed = parseMarkdownDocument("concepts/tagged.md", [
      "---",
      "type: Note",
      "metadata:",
      "  ordered: !!omap [{a: 1}, {b: 2}]",
      "  tagged_ordered: !!omap [{a: !!timestamp 2020-01-01}, {b: !!binary SGVsbG8=}]",
      "  pairs: !!pairs [{a: 1}, {b: 2}]",
      "  set: !!set {a: null, b: null}",
      "  binary: !!binary SGVsbG8=",
      "  timestamp: !!timestamp 2020-01-01T12:34:56Z",
      "  custom: !custom value",
      "  encoded_custom: !<tag:example.com,2026:foo%2Fbar> value",
      "---",
      "# Tagged",
      ""
    ].join("\n"), "concepts/tagged");

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.frontmatter).toEqual({
      type: "Note",
      metadata: {
        ordered: [{ a: 1 }, { b: 2 }],
        tagged_ordered: [{ a: "2020-01-01" }, { b: "SGVsbG8=" }],
        pairs: [{ a: 1 }, { b: 2 }],
        set: { a: null, b: null },
        binary: "SGVsbG8=",
        timestamp: "2020-01-01T12:34:56Z",
        custom: { "!custom": "value" },
        encoded_custom: { "!tag:example.com,2026:foo/bar": "value" }
      }
    });
  });

  it.each([
    "!!null x",
    "!!bool yes",
    "!!int abc",
    "!!float abc",
    "!!float 42",
    "!!set [x, y]",
    "!!str [x, y]",
    "!!unknown x"
  ])(
    "rejects invalid explicit YAML tag value %s",
    (value) => {
      const parsed = parseMarkdownDocument(
        "concepts/bad.md",
        `---\nmetadata: ${value}\n---\n# Bad\n`,
        "concepts/bad"
      );

      expect(parsed.frontmatter).toBeUndefined();
      expect(parsed.diagnostics[0]).toMatchObject({
        code: "spec/invalid-frontmatter",
        message: "Frontmatter contains an invalid explicit YAML tag value."
      });
    }
  );

  it("rejects a custom tag wrapped around the root frontmatter mapping", () => {
    const parsed = parseMarkdownDocument(
      "concepts/bad.md",
      "---\n!custom {type: Note}\n---\n# Bad\n",
      "concepts/bad"
    );

    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.diagnostics[0]).toMatchObject({
      code: "spec/invalid-frontmatter",
      message: "Frontmatter must be a YAML mapping."
    });
  });

  it("extracts heading locations after frontmatter", () => {
    const parsed = parseMarkdownDocument("concepts/wau.md", "---\ntype: Metric\n---\n\n# Heading\n", "concepts/wau");

    expect(parsed.body.headings[0]).toMatchObject({
      level: 1,
      title: "Heading",
      slug: "heading",
      location: {
        start: {
          line: 5,
          column: 1
        }
      }
    });
  });
});

describe("resolveConfig", () => {
  it("expands built-in presets and keeps explicit rule overrides", () => {
    const config = resolveConfig({
      presets: ["@okfx/preset-strict", "agent-ready"],
      plugins: [
        "@acme/okfx-plugin",
        {
          package: "./local-plugin.ts",
          enabled: false,
          options: {
            requiredOwner: "data-platform"
          }
        }
      ],
      rules: {
        "hygiene/missing-title": "off"
      }
    });

    expect(config.failOn).toBe("warning");
    expect(config.rules["hygiene/missing-description"]).toBe("error");
    expect(config.rules["agent/metric-missing-source"]).toBe("warning");
    expect(config.rules["hygiene/missing-title"]).toBe("off");
    expect(config.plugins).toEqual([
      {
        package: "@acme/okfx-plugin",
        enabled: true,
        options: {}
      },
      {
        package: "./local-plugin.ts",
        enabled: false,
        options: {
          requiredOwner: "data-platform"
        }
      }
    ]);
  });

  it.each(["recomended", "toString", "constructor", "__proto__"])(
    "rejects unknown preset %j instead of reading inherited properties",
    (preset) => {
      expect(() => resolveConfig({ presets: [preset] }))
        .toThrow(`Unknown okfx preset "${preset}"`);
    }
  );

  it("ignores inherited top-level and nested config fields", () => {
    const inheritedConfig = Object.create({
      include: ["inherited.md"],
      presets: ["strict"],
      plugins: ["./inherited-plugin.ts"],
      rules: {
        "hygiene/missing-title": "off"
      },
      failOn: "warning",
      frontmatter: {
        keyOrder: ["title"]
      },
      resourcePolicy: {
        allowHosts: ["inherited.example"]
      },
      mcp: {
        readonly: false
      }
    });
    const nestedConfig = {
      frontmatter: Object.create({ keyOrder: ["title"] }),
      resourcePolicy: Object.create({ allowHosts: ["inherited.example"] }),
      mcp: Object.create({ readonly: false, exposeDiagnostics: false, exposeGraph: false })
    };

    const resolvedInherited = resolveConfig(inheritedConfig);
    const resolvedNested = resolveConfig(nestedConfig);

    expect(resolvedInherited).toMatchObject({
      include: ["**/*.md"],
      presets: ["recommended"],
      plugins: [],
      failOn: "error",
      resourcePolicy: {
        allowHosts: []
      },
      mcp: {
        readonly: true
      }
    });
    expect(resolvedInherited.rules["hygiene/missing-title"]).toBe("warning");
    expect(resolvedInherited.frontmatter.keyOrder[0]).toBe("type");
    expect(resolvedNested.frontmatter.keyOrder[0]).toBe("type");
    expect(resolvedNested.resourcePolicy.allowHosts).toEqual([]);
    expect(resolvedNested.mcp).toEqual({
      readonly: true,
      exposeDiagnostics: true,
      exposeGraph: true
    });
  });

  it("ignores inherited fields while merging config overrides", () => {
    const base = resolveConfig({
      include: ["base.md"],
      presets: [],
      failOn: "info"
    });
    const inheritedOverride = Object.create({
      include: ["inherited.md"],
      presets: ["strict"],
      failOn: "warning"
    });

    const merged = mergeConfig(base, inheritedOverride);

    expect(merged.include).toEqual(["base.md"]);
    expect(merged.presets).toEqual([]);
    expect(merged.failOn).toBe("info");
  });

  it("requires plugin reference fields to be own properties", () => {
    const inheritedPackage = Object.create({ package: "./inherited-plugin.ts" });
    const inheritedSettings = Object.assign(
      Object.create({ enabled: false, options: { inherited: true } }),
      { package: "./local-plugin.ts" }
    );

    expect(() => resolveConfig({ plugins: [inheritedPackage] }))
      .toThrow("Invalid okfx config: plugins[0].package");
    expect(resolveConfig({ plugins: [inheritedSettings] }).plugins).toEqual([{
      package: "./local-plugin.ts",
      enabled: true,
      options: {}
    }]);
  });

  it.each([
    [{ failOn: "never" }, "failOn"],
    [{ include: "**/*.md" }, "include"],
    [{ presets: Array(1) }, "presets"],
    [{ rules: { "security/private-key": "disabled" } }, "rules.security/private-key"],
    [{ rules: { "custom/rule": ["warning", []] } }, "rules.custom/rule"],
    [{ plugins: [{ package: "" }] }, "plugins[0].package"],
    [{ mcp: { exposeGraph: "yes" } }, "mcp.exposeGraph"]
  ])("rejects invalid runtime config at %s", (config, path) => {
    expect(() => resolveConfig(config as never)).toThrow(`Invalid okfx config: ${path}`);
  });

  it("rejects invalid JSON config before it can weaken lint thresholds", async () => {
    const root = await tempBundle();
    await write(root, "okfx.config.json", JSON.stringify({ failOn: "never" }));
    await write(root, "concept.md", "---\ntype: Note\n---\n# Concept\n");

    await expect(loadBundle(root)).rejects.toThrow("Invalid okfx config: failOn");
  });

  it("does not hide unexpected config lookup failures", async () => {
    const root = await tempBundle();
    await symlink("okfx.config.ts", join(root, "okfx.config.ts"));

    await expect(findConfigFile(root)).rejects.toMatchObject({ code: "ELOOP" });
  });
});
