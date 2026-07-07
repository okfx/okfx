import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadBundle, parseMarkdownDocument, resolveConfig } from "../src/index.js";

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
});
