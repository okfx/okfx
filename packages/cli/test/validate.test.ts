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
  const root = await mkdtemp(join(tmpdir(), "okfx-validate-cli-"));
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

describe("okf validate", () => {
  it("fails when the bundle root does not exist", async () => {
    const root = await tempRoot();
    const missing = join(root, "missing");
    const output = capture();

    const code = await main(["validate", "--", missing], output.io);

    expect(code).toBe(2);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("OKF bundle root does not exist");
  });

  it("passes valid bundles", async () => {
    const root = await tempRoot();
    await write(root, "concepts/example.md", "---\ntype: Note\n---\n# Example\n");
    const output = capture();

    const code = await main(["validate", root], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("OKF validation passed");
    expect(output.stderr()).toBe("");
  });

  it("fails invalid bundles", async () => {
    const root = await tempRoot();
    await write(root, "concepts/example.md", "---\ntitle: Example\n---\n# Example\n");
    const output = capture();

    const code = await main(["validate", root], output.io);

    expect(code).toBe(1);
    expect(output.stdout()).toContain("OKF validation failed");
    expect(output.stdout()).toContain("spec/missing-type");
  });

  it("prints JSON output", async () => {
    const root = await tempRoot();
    await write(root, "concepts/example.md", "# Example\n");
    const output = capture();

    const code = await main(["validate", root, "--format", "json"], output.io);
    const parsed = JSON.parse(output.stdout()) as { ok: boolean; diagnostics: Array<{ code: string }> };

    expect(code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics[0]?.code).toBe("spec/missing-frontmatter");
  });

  it("writes output to a file", async () => {
    const root = await tempRoot();
    await write(root, "concepts/example.md", "---\ntype: Note\n---\n# Example\n");
    const out = join(root, ".okfx", "validation.json");
    const output = capture();

    const code = await main(["validate", root, "--json", "--out", out], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toBe("");
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ ok: true });
  });

  it("supports explicit OKF version compatibility override", async () => {
    const root = await tempRoot();
    await write(root, "okfx.config.ts", "export default { okfVersion: '9.9' };\n");
    await write(root, "concepts/example.md", "---\ntype: Note\n---\n# Example\n");

    const unsupported = capture();
    const unsupportedCode = await main(["validate", root], unsupported.io);

    expect(unsupportedCode).toBe(1);
    expect(unsupported.stdout()).toContain("spec/unsupported-okf-version");

    const overridden = capture();
    const overriddenCode = await main(["validate", root, "--okf-version", "0.1"], overridden.io);

    expect(overriddenCode).toBe(0);
    expect(overridden.stdout()).toContain("OKF validation passed");
  });
});
