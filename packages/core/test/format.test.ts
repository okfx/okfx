import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { formatBundle, formatMarkdownFile, parseMarkdownDocument } from "../src/index.js";

describe("formatMarkdownFile", () => {
  it("orders frontmatter, normalizes timestamps, and trims body whitespace", () => {
    const result = formatMarkdownFile("concept.md", `---
title: Example
type: Note
timestamp: 2026-07-07
tags:
- b
- a
---

# Example   


Body   
`);

    expect(result.changed).toBe(true);
    expect(result.formatted).toBe(`---
type: Note
title: Example
tags:
  - b
  - a
timestamp: 2026-07-07T00:00:00.000Z
---

# Example

Body
`);
  });

  it("normalizes only valid calendar date shorthands", () => {
    const formatTimestamp = (timestamp: string) => formatMarkdownFile("concept.md", `---
type: Note
timestamp: ${timestamp}
---
# Example
`).formatted;

    expect(formatTimestamp("2024-02-29")).toContain("timestamp: 2024-02-29T00:00:00.000Z");
    expect(formatTimestamp("2025-02-29")).toContain("timestamp: 2025-02-29\n");
    expect(formatTimestamp("July 7, 2026")).toContain("timestamp: July 7, 2026\n");
  });

  it("formats frontmatter with carriage-return line endings", () => {
    const result = formatMarkdownFile(
      "concept.md",
      "---\rtitle: Example\rtype: Note\r---\r# Example\r"
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.formatted).toBe("---\ntype: Note\ntitle: Example\n---\n\n# Example\n");
  });

  it("does not rewrite frontmatter rejected by the parser", () => {
    const aliasBomb = [
      "a: &a [x,x,x,x,x]",
      "b: &b [*a,*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b,*b]",
      "d: &d [*c,*c,*c,*c,*c]",
      "root: *d"
    ].join("\n");
    const cases = [
      ["non-finite number", "type: Note\nvalue: .inf"],
      ["recursive alias", "type: Note\nvalue: &value [*value]"],
      ["non-string nested key", "type: Note\nmetadata: {1: one}"],
      ["invalid explicit tag", "type: Note\nvalue: !!int 1.5"],
      ["custom root tag", "!custom {type: Note}"],
      ["excessive nesting", `type: Note\nvalue: ${"[".repeat(200)}0${"]".repeat(200)}`],
      ["excessive alias expansion", aliasBomb]
    ] as const;

    for (const [name, frontmatter] of cases) {
      const content = `---\n${frontmatter}\n---\n# Example   \n`;
      const parsed = parseMarkdownDocument("concept.md", content, "concept");
      const formatted = formatMarkdownFile("concept.md", content);

      expect(parsed.diagnostics.length, name).toBeGreaterThan(0);
      expect(formatted.diagnostics, name).toEqual(parsed.diagnostics);
      expect(formatted.changed, name).toBe(false);
      expect(formatted.formatted, name).toBe(content);
    }
  });

  it("preserves YAML comments and anchor relationships while ordering keys", () => {
    const result = formatMarkdownFile("concept.md", `---
description: &summary Shared description # keep anchor comment
title: Example # keep title comment
type: Note
usage: *summary
---

# Example
`);

    expect(result.diagnostics).toEqual([]);
    expect(result.formatted).toContain("type: Note\ntitle: Example # keep title comment\ndescription: &summary Shared description # keep anchor comment\nusage: *summary");
  });

  it("keeps anchor owners before aliases when lexical key order conflicts", () => {
    const result = formatMarkdownFile("concept.md", `---
z_anchor: &summary Shared description
a_alias: *summary
type: Note
---
# Example
`);

    expect(result.diagnostics).toEqual([]);
    expect(result.formatted).toContain("type: Note\nz_anchor: &summary Shared description\na_alias: *summary");
  });

  it("orders large frontmatter configs without rescanning the configured keys", () => {
    const keyOrder = Array.from({ length: 20_000 }, (_, index) => `configured_${index}`);
    const keys = Array.from({ length: 1_500 }, (_, index) => `configured_${19_999 - index}`);
    const content = `---\n${keys.map((key) => `${key}: value`).join("\n")}\n---\n# Example\n`;
    const started = performance.now();

    const result = formatMarkdownFile("concept.md", content, {
      frontmatter: { keyOrder }
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.formatted.indexOf("configured_18500:"))
      .toBeLessThan(result.formatted.indexOf("configured_19999:"));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("preserves alias targets when anchor names are redefined", () => {
    const result = formatMarkdownFile("concept.md", `---
z: &shared one
a: *shared
y: &shared two
b: *shared
type: Note
---

# Example
`);
    const parsed = parseMarkdownDocument("concept.md", result.formatted, "concept");

    expect(parsed.frontmatter).toMatchObject({
      a: "one",
      b: "two"
    });
  });

  it("does not rewrite whitespace inside fenced code blocks", () => {
    const content = [
      "---",
      "type: Note",
      "title: Example",
      "---",
      "",
      "# Example   ",
      "",
      "```text",
      "first  ",
      "",
      "",
      "second\t",
      "```",
      "",
      "After   ",
      ""
    ].join("\n");

    const result = formatMarkdownFile("concept.md", content);

    expect(result.formatted).toContain("# Example\n\n```text\nfirst  \n\n\nsecond\t\n```\n\nAfter\n");
  });

  it("does not treat a backtick in the info string as a fenced code opener", () => {
    const content = [
      "```bad`info",
      "first  ",
      "",
      "",
      "second\t",
      ""
    ].join("\n");

    const result = formatMarkdownFile("concept.md", content);

    expect(result.formatted).toBe("```bad`info\nfirst\n\nsecond\n");
  });
});

describe("formatBundle", () => {
  it("checks and writes bundle formatting", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-fmt-"));
    try {
      await mkdir(join(root, "concepts"), { recursive: true });
      await writeFile(join(root, "concepts/example.md"), "---\ntitle: Example\ntype: Note\n---\n# Example   ", "utf8");

      const check = await formatBundle(root, { loadConfigFile: false, check: true });
      expect(check.ok).toBe(false);
      expect(check.changed).toBe(true);

      const write = await formatBundle(root, { loadConfigFile: false });
      expect(write.ok).toBe(true);
      expect(await readFile(join(root, "concepts/example.md"), "utf8")).toContain("type: Note\ntitle: Example");

      const clean = await formatBundle(root, { loadConfigFile: false, check: true });
      expect(clean.ok).toBe(true);
      expect(clean.changed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves file config when applying runtime overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-fmt-config-"));
    try {
      await mkdir(join(root, "knowledge"), { recursive: true });
      await mkdir(join(root, "outside"), { recursive: true });
      await writeFile(
        join(root, "okfx.config.json"),
        JSON.stringify({ include: ["knowledge/**/*.md"] }),
        "utf8"
      );
      const content = "---\ntype: Note\ntitle: Example\n---\n# Example   ";
      await writeFile(join(root, "knowledge/example.md"), content, "utf8");
      await writeFile(join(root, "outside/example.md"), content, "utf8");

      const result = await formatBundle(root, {
        config: { frontmatter: { keyOrder: ["title", "type"] } }
      });

      expect(result.files.map((file) => file.path)).toEqual(["knowledge/example.md"]);
      expect(await readFile(join(root, "knowledge/example.md"), "utf8"))
        .toContain("title: Example\ntype: Note");
      expect(await readFile(join(root, "outside/example.md"), "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not format files discovered outside the bundle root", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-fmt-contained-"));
    const outside = join(root, "..", `okfx-fmt-outside-${Date.now()}.md`);
    const content = "---\ntitle: Outside\ntype: Note\n---\n# Outside   ";
    try {
      await writeFile(outside, content, "utf8");

      await expect(formatBundle(root, {
        loadConfigFile: false,
        config: { include: [outside] }
      })).rejects.toThrow("escapes the OKF bundle root");
      expect(await readFile(outside, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });
});
