import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadBundle } from "@okfx/core";

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
  const root = await mkdtemp(join(tmpdir(), "okfx-init-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("okf init", () => {
  it("creates a minimal bundle", async () => {
    const root = join(await tempRoot(), "knowledge");
    const output = capture();
    const now = new Date("2024-03-02T01:02:03Z");

    const code = await main(["init", root], output.io, { now: () => now });

    expect(code).toBe(0);
    expect(output.stdout()).toContain("Created OKF bundle");
    expect(existsSync(join(root, "index.md"))).toBe(true);
    expect(existsSync(join(root, "log.md"))).toBe(true);
    expect(existsSync(join(root, "okfx.config.ts"))).toBe(true);
    expect(existsSync(join(root, "concepts/example.md"))).toBe(true);

    const bundle = await loadBundle(root);
    expect(bundle.stats.conceptCount).toBe(1);
    expect(bundle.stats.brokenLinkCount).toBe(0);
    expect(bundle.concepts[0]).toMatchObject({
      id: "concepts/example",
      type: "Note",
      title: "Example Concept",
      timestamp: "2024-03-02T01:02:03.000Z"
    });
    expect(await readFile(join(root, "log.md"), "utf8")).toContain("## 2024-03-02");
  });

  it("creates the data-platform template", async () => {
    const root = join(await tempRoot(), "knowledge");
    const output = capture();

    const code = await main(["init", root, "--template", "data-platform"], output.io);

    expect(code).toBe(0);
    const bundle = await loadBundle(root);
    expect(bundle.concepts.map((concept) => concept.id).sort()).toEqual([
      "metrics/weekly_active_users",
      "tables/user_events"
    ]);
  });

  it("creates a self-contained metrics template", async () => {
    const root = join(await tempRoot(), "knowledge");
    const output = capture();

    const code = await main(["init", root, "--template", "metrics"], output.io);

    expect(code).toBe(0);
    const bundle = await loadBundle(root);
    expect(bundle.concepts.map((concept) => concept.id).sort()).toEqual([
      "concepts/example",
      "tables/user_events"
    ]);
    expect(bundle.stats.brokenLinkCount).toBe(0);
  });

  it("refuses to overwrite generated files unless forced", async () => {
    const root = join(await tempRoot(), "knowledge");
    const first = capture();
    const second = capture();
    const forced = capture();

    expect(await main(["init", root], first.io)).toBe(0);
    expect(await main(["init", root], second.io)).toBe(2);
    expect(second.stderr()).toContain("refusing to overwrite existing files");

    expect(await main(["init", root, "--force"], forced.io)).toBe(0);
    expect(await readFile(join(root, "index.md"), "utf8")).toContain("# Knowledge Index");
  });
});
