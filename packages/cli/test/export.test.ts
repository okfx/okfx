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

async function tempBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "okfx-export-cli-"));
  roots.push(root);
  await mkdir(join(root, "concepts"), { recursive: true });
  await writeFile(join(root, "concepts/example.md"), "---\ntype: Note\ntitle: Example\ndescription: Demo\n---\n# Example\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("okf export", () => {
  it("prints static site files in dry-run mode", async () => {
    const root = await tempBundle();
    const output = capture();

    const code = await main(["export", "static-site", root], output.io);
    const parsed = JSON.parse(output.stdout()) as { target: string; files: Array<{ path: string; content: string }> };

    expect(code).toBe(0);
    expect(parsed.target).toBe("static-site");
    expect(parsed.files.map((file) => file.path).sort()).toEqual([
      "concepts/concepts/example.html",
      "graph.json",
      "index.html"
    ]);
  });

  it("writes static site files with --write", async () => {
    const root = await tempBundle();
    const out = join(root, "site");
    const output = capture();

    const code = await main(["export", "static-site", root, "--out", out, "--write"], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("Exported 3 static-site files");
    expect((await stat(join(out, "index.html"))).isFile()).toBe(true);
    expect(await readFile(join(out, "concepts/concepts/example.html"), "utf8")).toContain("Example");
  });
});
