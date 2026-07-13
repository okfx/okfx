import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "okfx-fmt-cli-"));
  roots.push(root);
  return root;
}

async function write(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("okf fmt", () => {
  it("fails when the bundle root does not exist", async () => {
    const root = await tempRoot();
    const output = capture();

    const code = await main(["fmt", join(root, "missing"), "--check"], output.io);

    expect(code).toBe(2);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("OKF bundle root does not exist");
  });

  it("checks formatting without writing", async () => {
    const root = await tempRoot();
    await write(root, "concept.md", "---\ntitle: Example\ntype: Note\n---\n# Example   ");
    const output = capture();

    const code = await main(["fmt", root, "--check"], output.io);

    expect(code).toBe(1);
    expect(output.stdout()).toContain("OKF format check failed");
    expect(await readFile(join(root, "concept.md"), "utf8")).toContain("title: Example\ntype: Note");
  });

  it("formats files", async () => {
    const root = await tempRoot();
    await write(root, "concept.md", "---\ntitle: Example\ntype: Note\n---\n# Example   ");
    const output = capture();

    const code = await main(["fmt", root], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("OKF files formatted");
    expect(await readFile(join(root, "concept.md"), "utf8")).toContain("type: Note\ntitle: Example");
  });

  it("prints JSON", async () => {
    const root = await tempRoot();
    await write(root, "concept.md", "---\ntype: Note\n---\n\n# Example\n");
    const output = capture();

    const code = await main(["fmt", root, "--json"], output.io);
    const parsed = JSON.parse(output.stdout()) as { ok: boolean; changed: boolean };

    expect(code).toBe(0);
    expect(parsed).toMatchObject({ ok: true, changed: false });
  });
});
