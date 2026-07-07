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
  const root = await mkdtemp(join(tmpdir(), "okfx-diff-cli-"));
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

describe("okf diff", () => {
  it("prints pretty semantic changes", async () => {
    const before = await tempRoot();
    const after = await tempRoot();
    await write(before, "concept.md", "---\ntype: Note\ntitle: Old\n---\n# Old\n");
    await write(after, "concept.md", "---\ntype: Note\ntitle: New\n---\n# New\n");
    const output = capture();

    const code = await main(["diff", before, after], output.io);

    expect(code).toBe(1);
    expect(output.stdout()).toContain("Bundle diff");
    expect(output.stdout()).toContain("frontmatter.title changed");
    expect(output.stdout()).toContain("Agent readiness:");
  });

  it("returns zero for no changes", async () => {
    const before = await tempRoot();
    const after = await tempRoot();
    const content = "---\ntype: Note\ntitle: Same\n---\n# Same\n";
    await write(before, "concept.md", content);
    await write(after, "concept.md", content);
    const output = capture();

    const code = await main(["diff", before, after], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("No semantic changes");
  });

  it("writes markdown output", async () => {
    const before = await tempRoot();
    const after = await tempRoot();
    await write(before, "old.md", "---\ntype: Note\ntitle: Old\n---\n# Old\n");
    await write(after, "new.md", "---\ntype: Note\ntitle: New\n---\n# New\n");
    const out = join(after, ".okfx", "diff.md");
    const output = capture();

    const code = await main(["diff", before, after, "--format", "markdown", "--out", out], output.io);

    expect(code).toBe(1);
    expect(output.stdout()).toBe("");
    expect(await readFile(out, "utf8")).toContain("## OKF Diff");
  });
});
