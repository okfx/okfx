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
  const root = await mkdtemp(join(tmpdir(), "okfx-lint-cli-"));
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

describe("okf lint", () => {
  it("prints warnings without failing the default error threshold", async () => {
    const root = await tempRoot();
    await write(root, "concept.md", "---\ntype: Note\n---\n# Concept\n");
    const output = capture();

    const code = await main(["lint", root], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("OKF lint passed");
    expect(output.stdout()).toContain("hygiene/missing-title");
  });

  it("fails when config failOn is warning", async () => {
    const root = await tempRoot();
    await write(root, "okfx.config.ts", "export default { failOn: 'warning' };\n");
    await write(root, "concept.md", "---\ntype: Note\n---\n# Concept\n");
    const output = capture();

    const code = await main(["lint", root], output.io);

    expect(code).toBe(1);
    expect(output.stdout()).toContain("failOn: warning");
  });

  it("prints JSON output and writes output files", async () => {
    const root = await tempRoot();
    await write(root, "concept.md", "---\ntype: Note\n---\n# Concept\n");
    const out = join(root, ".okfx", "lint.json");
    const output = capture();

    const code = await main(["lint", root, "--json", "--out", out], output.io);
    const parsed = JSON.parse(await readFile(out, "utf8")) as { ok: boolean; diagnostics: Array<{ code: string }> };

    expect(code).toBe(0);
    expect(output.stdout()).toBe("");
    expect(parsed.ok).toBe(true);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("hygiene/missing-title");
  });

  it("fails on suspicious secrets", async () => {
    const root = await tempRoot();
    await write(root, "concept.md", "---\ntype: Note\ntitle: Concept\ndescription: Demo\n---\napi_key = abcdefghijklmnopqrstuvwxyz\n");
    const output = capture();

    const code = await main(["lint", root], output.io);

    expect(code).toBe(1);
    expect(output.stdout()).toContain("security/suspicious-secret");
  });
});
