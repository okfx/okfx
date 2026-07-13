import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as tar from "tar";
import { describe, expect, it } from "vitest";

import { packBundle } from "../src/index.js";

describe("packBundle", () => {
  it("writes metadata and archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-"));
    const out = join(root, "..", "knowledge.okf.tar.gz");
    try {
      await mkdir(join(root, "concepts"), { recursive: true });
      await writeFile(join(root, "okfx.config.ts"), "export default { okfVersion: '0.1' };\n", "utf8");
      await writeFile(join(root, "concepts/example.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");

      const result = await packBundle(root, {
        out,
        createdAt: new Date("2026-07-07T00:00:00Z")
      });
      const manifest = JSON.parse(await readFile(join(root, ".okfx", "manifest.json"), "utf8")) as typeof result.manifest;
      const entries: string[] = [];
      await tar.list({
        file: out,
        onentry(entry) {
          entries.push(entry.path);
        }
      });

      expect((await stat(out)).size).toBeGreaterThan(0);
      expect(manifest).toMatchObject({
        okfx_version: "0.1.0",
        okf_version: "0.1",
        concept_count: 1,
        file_count: 2
      });
      expect(manifest.files.map((file) => file.path).sort()).toEqual(["concepts/example.md", "okfx.config.ts"]);
      expect(entries).toContain(".okfx/manifest.json");
      expect(entries).toContain("concepts/example.md");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });

  it("does not include an existing output archive when packing repeatedly", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-repeat-"));
    const out = join(root, "knowledge.okf.tar.gz");
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");

      await packBundle(root, { out, createdAt: new Date("2026-07-07T00:00:00Z") });
      const result = await packBundle(root, { out, createdAt: new Date("2026-07-07T00:00:00Z") });
      const entries = await archiveEntries(out);

      expect(result.manifest.files.map((file) => file.path)).toEqual(["concept.md"]);
      expect(entries).not.toContain("knowledge.okf.tar.gz");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes dotenv secrets while retaining an example file", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-secrets-"));
    const out = join(root, "..", "secrets.okf.tar.gz");
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");
      await writeFile(join(root, ".env"), "TOKEN=secret\n", "utf8");
      await writeFile(join(root, ".env.local"), "TOKEN=local-secret\n", "utf8");
      await writeFile(join(root, ".env.example"), "TOKEN=\n", "utf8");

      const result = await packBundle(root, { out });

      expect(result.manifest.files.map((file) => file.path)).toEqual([".env.example", "concept.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });

  it("creates an archive without metadata when metadata writes are disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-no-metadata-"));
    const out = join(root, "..", "no-metadata.okf.tar.gz");
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");

      await packBundle(root, { out, writeMetadata: false });

      expect(await archiveEntries(out)).toEqual(["concept.md"]);
      await expect(stat(join(root, ".okfx"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });
});

async function archiveEntries(path: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.list({
    file: path,
    onentry(entry) {
      entries.push(entry.path);
    }
  });
  return entries;
}
