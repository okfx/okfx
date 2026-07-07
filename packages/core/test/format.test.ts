import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { formatBundle, formatMarkdownFile } from "../src/index.js";

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
});
