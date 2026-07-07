import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "okfx-pack-cli-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("okf pack", () => {
  it("packs a bundle and prints pretty output", async () => {
    const root = await tempRoot();
    const out = join(root, "knowledge.okf.tar.gz");
    await mkdir(join(root, "concepts"), { recursive: true });
    await writeFile(join(root, "concepts/example.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");
    const output = capture();

    const code = await main(["pack", root, "--out", out, "--name", "knowledge"], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("OKF bundle packed");
    expect((await stat(out)).size).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(root, ".okfx", "manifest.json"), "utf8"))).toMatchObject({
      bundle_name: "knowledge"
    });
  });

  it("prints JSON output", async () => {
    const root = await tempRoot();
    const out = join(root, "knowledge.okf.tar.gz");
    await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");
    const output = capture();

    const code = await main(["pack", root, "--out", out, "--json"], output.io);
    const parsed = JSON.parse(output.stdout()) as { out: string; manifest: { concept_count: number } };

    expect(code).toBe(0);
    expect(parsed.out).toBe(out);
    expect(parsed.manifest.concept_count).toBe(1);
  });
});
