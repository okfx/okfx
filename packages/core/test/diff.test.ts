import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

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
    } finally {
      await before.cleanup();
      await after.cleanup();
    }
  });
});
