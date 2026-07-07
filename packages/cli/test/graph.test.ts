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
  const root = await mkdtemp(join(tmpdir(), "okfx-graph-cli-"));
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

describe("okf graph", () => {
  it("prints graph JSON", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "---\ntype: Note\ntitle: A\n---\n[B](b.md)\n");
    await write(root, "b.md", "---\ntype: Note\ntitle: B\n---\n# B\n");
    const output = capture();

    const code = await main(["graph", root], output.io);
    const graph = JSON.parse(output.stdout()) as { stats: { nodeCount: number }; edges: Array<{ source: string; target: string }> };

    expect(code).toBe(0);
    expect(graph.stats.nodeCount).toBe(2);
    expect(graph.edges[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("writes DOT output", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "---\ntype: Note\ntitle: A\n---\n[B](b.md)\n");
    await write(root, "b.md", "---\ntype: Note\ntitle: B\n---\n# B\n");
    const out = join(root, ".okfx", "graph.dot");
    const output = capture();

    const code = await main(["graph", root, "--format", "dot", "--out", out], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toBe("");
    expect(await readFile(out, "utf8")).toContain('"a" -> "b"');
  });

  it("prints HTML output", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "---\ntype: Note\ntitle: A\n---\n# A\n");
    const output = capture();

    const code = await main(["graph", root, "--format", "html"], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("<title>OKF Graph</title>");
  });

  it("prints Cytoscape elements", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "---\ntype: Note\ntitle: A\ntags:\n  - analytics\n---\n[B](b.md)\n");
    await write(root, "b.md", "---\ntype: Note\ntitle: B\n---\n# B\n");
    const output = capture();

    const code = await main(["graph", root, "--format", "cytoscape"], output.io);
    const cytoscape = JSON.parse(output.stdout()) as { elements: { nodes: Array<{ data: { id: string } }>; edges: Array<{ data: { kind: string } }> } };

    expect(code).toBe(0);
    expect(cytoscape.elements.nodes.map((node) => node.data.id)).toContain("tag:analytics");
    expect(cytoscape.elements.edges.map((edge) => edge.data.kind)).toContain("markdown-link");
  });
});
