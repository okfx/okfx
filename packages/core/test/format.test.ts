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
