import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "okfx-import-cli-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("okf import", () => {
  it("prints generated files in dry-run mode", async () => {
    const root = await tempRoot();
    const input = join(root, "openapi.json");
    await writeFile(input, JSON.stringify({ paths: { "/orders": { get: { summary: "List Orders" } } } }), "utf8");
    const output = capture();

    const code = await main(["import", "openapi", "--input", input], output.io);
    const parsed = JSON.parse(output.stdout()) as { files: Array<{ path: string }> };

    expect(code).toBe(0);
    expect(parsed.files[0]?.path).toBe("apis/get-orders.md");
  });

  it("writes generated files with --write", async () => {
    const root = await tempRoot();
    const input = join(root, "bq.json");
    const out = join(root, "knowledge");
    await writeFile(input, JSON.stringify([{ project: "p", dataset: "d", table: "orders" }]), "utf8");
    const output = capture();

    const code = await main(["import", "bigquery", "--input", input, "--out", out, "--write"], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("Generated 1 OKF files");
    expect((await stat(join(out, "tables/d-orders.md"))).isFile()).toBe(true);
    expect(await readFile(join(out, "tables/d-orders.md"), "utf8")).toContain("bigquery://p/d/orders");
  });
});
