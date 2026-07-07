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
  const root = await mkdtemp(join(tmpdir(), "okfx-doctor-cli-"));
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

describe("okf doctor", () => {
  it("prints agent-readiness output", async () => {
    const root = await tempRoot();
    await write(root, "metrics/wau.md", "---\ntype: Metric\ntitle: WAU\ndescription: Demo\n---\n# WAU\n");
    const output = capture();

    const code = await main(["doctor", root], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("OKF Doctor");
    expect(output.stdout()).toContain("Agent readiness:");
    expect(output.stdout()).toContain("agent/metric-missing-source");
  });

  it("honors failOn warning", async () => {
    const root = await tempRoot();
    await write(root, "okfx.config.ts", "export default { failOn: 'warning' };\n");
    await write(root, "metrics/wau.md", "---\ntype: Metric\ntitle: WAU\ndescription: Demo\n---\n# WAU\n");
    const output = capture();

    const code = await main(["doctor", root], output.io);

    expect(code).toBe(1);
    expect(output.stdout()).toContain("failOn: warning");
  });

  it("writes JSON output", async () => {
    const root = await tempRoot();
    await write(root, "metrics/wau.md", "---\ntype: Metric\ntitle: WAU\ndescription: Demo\n---\n# WAU\n");
    const out = join(root, ".okfx", "doctor.json");
    const output = capture();

    const code = await main(["doctor", root, "--json", "--out", out], output.io);
    const parsed = JSON.parse(await readFile(out, "utf8")) as { score: number; diagnostics: Array<{ code: string }> };

    expect(code).toBe(0);
    expect(output.stdout()).toBe("");
    expect(parsed.score).toBeLessThan(100);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("agent/metric-missing-source");
  });
});
