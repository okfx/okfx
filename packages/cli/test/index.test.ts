import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/index.js";
import type { CliIO } from "../src/program.js";

const roots: string[] = [];

function capture(): { io: CliIO; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: string): boolean {
          stdout += chunk;
          return true;
        }
      },
      stderr: {
        write(chunk: string): boolean {
          stderr += chunk;
          return true;
        }
      }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "okfx-index-cli-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("okf index", () => {
  it("writes an index", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "concepts"), { recursive: true });
    await writeFile(join(root, "concepts/wau.md"), "---\ntype: Metric\ntitle: Weekly Active Users\n---\n# WAU\n", "utf8");
    const output = capture();

    const code = await main(["index", root], output.io);
    const index = JSON.parse(await readFile(join(root, ".okfx", "index", "index.json"), "utf8")) as { documents: Array<{ id: string }> };

    expect(code).toBe(0);
    expect(output.stdout()).toContain("OKF search index built");
    expect(index.documents[0]?.id).toBe("concepts/wau");
  });

  it("prints JSON summary", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Concept\n---\n# Concept\n", "utf8");
    const output = capture();

    const code = await main(["index", root, "--json"], output.io);
    const parsed = JSON.parse(output.stdout()) as { ok: boolean; documentCount: number };

    expect(code).toBe(0);
    expect(parsed).toMatchObject({ ok: true, documentCount: 1 });
  });

  it("requires explicit provider configuration for vector modes", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Concept\n---\n# Concept\n", "utf8");
    const output = capture();

    const code = await main(["index", root, "--mode", "vector"], output.io);

    expect(code).toBe(2);
    expect(output.stderr()).toContain("vector index mode requires explicit --vector-provider configuration");
  });

  it("rejects index output outside the bundle", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Concept\n---\n# Concept\n", "utf8");
    const output = capture();

    expect(await main(["index", root, "--out", "../outside"], output.io)).toBe(2);
    expect(output.stderr()).toContain("non-portable path");
  });

  it("refuses to write through a symlinked index directory", async () => {
    const root = await tempRoot();
    const external = join(root, "external");
    await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Concept\n---\n# Concept\n", "utf8");
    await mkdir(external);
    await symlink(external, join(root, ".okfx"), process.platform === "win32" ? "junction" : "dir");
    const output = capture();

    expect(await main(["index", root], output.io)).toBe(2);
    expect(output.stderr()).toContain("symbolic link");
    await expect(stat(join(external, "index", "index.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
