import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { diffBundles, loadBundle } from "../src/index.js";

async function bundle(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "okfx-diff-"));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }

  return {
    root,
    loaded: await loadBundle(root, { loadConfigFile: false }),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe("diffBundles", () => {
  it("uses one readiness timestamp for both sides of a diff", async () => {
    const current = await bundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\ntimestamp: 2025-01-01T00:00:00Z\n---\n# Concept\n"
    });
    const OriginalDate = Date;
    const staleBoundary = OriginalDate.parse("2025-01-01T00:00:00Z") + 180 * 24 * 60 * 60 * 1000;
    let noArgumentCalls = 0;
    class AdvancingDate extends OriginalDate {
      constructor(value?: string | number) {
        if (arguments.length === 0) {
          super(noArgumentCalls++ < 2 ? staleBoundary : staleBoundary + 1);
        } else {
          super(value!);
        }
      }
    }
    vi.stubGlobal("Date", AdvancingDate);

    try {
      const diff = diffBundles(current.loaded, current.loaded);

      expect(diff.agentReadiness).toMatchObject({ delta: 0, changed: false });
      expect(diff.stats.readinessChanged).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await current.cleanup();
    }
  });

  it("reports added, removed, renamed, and changed concepts", async () => {
    const before = await bundle({
      "same.md": "---\ntype: Note\ntitle: Same\n---\n# Same\n[Old](old-link.md)\n",
      "removed.md": "---\ntype: Note\ntitle: Removed\n---\n# Removed\n",
      "old-name.md": "---\ntype: Note\ntitle: Rename\n---\n# Rename\n"
    });
    const after = await bundle({
      "same.md": "---\ntype: Note\ntitle: Changed\n---\n# Same\n[New](new-link.md)\n",
      "added.md": "---\ntype: Note\ntitle: Added\n---\n# Added\n",
      "new-name.md": "---\ntype: Note\ntitle: Rename\n---\n# Rename\n"
    });

    try {
      const diff = diffBundles(before.loaded, after.loaded);

      expect(diff.addedConcepts).toEqual(["added"]);
      expect(diff.removedConcepts).toEqual(["removed"]);
      expect(diff.renamedConcepts).toEqual([
        expect.objectContaining({ from: "old-name", to: "new-name" })
      ]);
      expect(diff.changedConcepts[0]).toMatchObject({
        id: "same",
        frontmatterChanged: ["title"],
        bodyChanged: true
      });
      expect(diff.changedConcepts[0]?.linksAdded).toEqual(["new-link.md"]);
      expect(diff.changedConcepts[0]?.linksRemoved).toEqual(["old-link.md"]);
      expect(diff.agentReadiness).toEqual(expect.objectContaining({
        beforeScore: expect.any(Number),
        afterScore: expect.any(Number),
        delta: expect.any(Number),
        changed: expect.any(Boolean)
      }));
    } finally {
      await before.cleanup();
      await after.cleanup();
    }
  });

  it("reports agent-readiness score changes", async () => {
    const before = await bundle({
      "concept.md": "---\ntype: Metric\ntitle: WAU\n---\n# WAU\n"
    });
    const after = await bundle({
      "index.md": "# Index\n[WAU](concept.md)\n[Events](events.md)\n",
      "concept.md": `---
type: Metric
title: WAU
description: Weekly active users.
owner: data
---
# WAU

## Usage

[Events](events.md)
`,
      "events.md": "---\ntype: Table\ntitle: Events\ndescription: Source table.\n---\n# Events\n"
    });

    try {
      const diff = diffBundles(before.loaded, after.loaded);

      expect(diff.agentReadiness.changed).toBe(true);
      expect(diff.agentReadiness.afterScore).toBeGreaterThan(diff.agentReadiness.beforeScore);
    } finally {
      await before.cleanup();
      await after.cleanup();
    }
  });

  it("does not report reordered nested frontmatter mappings", async () => {
    const before = await bundle({
      "concept.md": `---
type: Note
title: Concept
metadata:
  owner: data
  settings:
    tier: 1
    enabled: true
---
# Concept
`
    });
    const after = await bundle({
      "concept.md": `---
metadata:
  settings:
    enabled: true
    tier: 1
  owner: data
title: Concept
type: Note
---
# Concept
`
    });

    try {
      const diff = diffBundles(before.loaded, after.loaded);

      expect(diff.changedConcepts).toEqual([]);
      expect(diff.stats.changedCount).toBe(0);
    } finally {
      await before.cleanup();
      await after.cleanup();
    }
  });

  it("reports added frontmatter keys that match object prototype names", async () => {
    const before = await bundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\n---\n# Concept\n"
    });
    const after = await bundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\n__proto__: {}\n---\n# Concept\n"
    });

    try {
      const diff = diffBundles(before.loaded, after.loaded);

      expect(diff.changedConcepts).toHaveLength(1);
      expect(diff.changedConcepts[0]?.frontmatterChanged).toEqual(["__proto__"]);
    } finally {
      await before.cleanup();
      await after.cleanup();
    }
  });

  it("reports resource and tag changes outside frontmatter", async () => {
    const before = await bundle({
      "concept.md": "---\ntype: Note\ntitle: Concept\n---\n# Concept\n"
    });

    try {
      const concept = before.loaded.concepts[0]!;
      const after = {
        ...before.loaded,
        concepts: [{
          ...concept,
          resource: "https://example.com/catalog",
          tags: ["analytics"]
        }]
      };

      const diff = diffBundles(before.loaded, after);

      expect(diff.stats.changedCount).toBe(1);
      expect(diff.changedConcepts[0]).toMatchObject({
        changes: ["resource changed", "tags changed"],
        resourceChanged: true,
        tagsChanged: true
      });
    } finally {
      await before.cleanup();
    }
  });

  it("produces the same rename pairs for permuted bundle inputs", async () => {
    const content = "---\ntype: Note\ntitle: Shared\n---\n# Shared\n";
    const before = await bundle({ "removed-b.md": content, "removed-a.md": content });
    const after = await bundle({ "added-b.md": content, "added-a.md": content });

    try {
      const forward = diffBundles(before.loaded, after.loaded);
      const reverse = diffBundles(
        { ...before.loaded, concepts: [...before.loaded.concepts].reverse() },
        { ...after.loaded, concepts: [...after.loaded.concepts].reverse() }
      );

      expect(reverse.renamedConcepts).toEqual(forward.renamedConcepts);
      expect(forward.renamedConcepts.map(({ from, to }) => [from, to])).toEqual([
        ["removed-a", "added-a"],
        ["removed-b", "added-b"]
      ]);
    } finally {
      await before.cleanup();
      await after.cleanup();
    }
  });
});
