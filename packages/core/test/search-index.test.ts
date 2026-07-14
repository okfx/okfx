import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { buildSearchIndex, loadBundle, tokenizeSearchText } from "../src/index.js";

describe("buildSearchIndex", () => {
  it("builds deterministic full-text documents and terms", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-index-"));
    try {
      await mkdir(join(root, "concepts"), { recursive: true });
      await writeFile(join(root, "index.md"), "# Index\n[WAU](concepts/wau.md)\n", "utf8");
      await writeFile(join(root, "concepts/wau.md"), `---
type: Metric
title: Weekly Active Users
description: Demo metric.
tags:
  - analytics
---

# Weekly Active Users

Counts active users.
`, "utf8");

      const index = buildSearchIndex(await loadBundle(root, { loadConfigFile: false }));

      expect(index.mode).toBe("full-text");
      expect(index.documents[0]).toMatchObject({
        id: "concepts/wau",
        backlinks: ["index"]
      });
      expect(index.terms.analytics).toEqual(["concepts/wau"]);
      expect(index.terms.weekly).toEqual(["concepts/wau"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("measures minimum term length in Unicode code points", () => {
    expect(tokenizeSearchText("中 中国 𐐀 𐐀𐐁")).toEqual(["中国", "𐐨𐐩"]);
  });

  it("returns terms in deterministic code-point order", () => {
    expect(tokenizeSearchText("zulu alpha beta alpha")).toEqual(["alpha", "beta", "zulu"]);
  });
});
