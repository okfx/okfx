import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("okf mcp", () => {
  it("describes the stdio server without starting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-mcp-cli-"));
    roots.push(root);
    const output = capture();

    const code = await main(["mcp", root, "--describe"], output.io);
    const parsed = JSON.parse(output.stdout()) as { root: string; readonly: boolean; tools: string[]; prompts: string[] };

    expect(code).toBe(0);
    expect(parsed.root).toBe(root);
    expect(parsed.readonly).toBe(true);
    expect(parsed.tools).toContain("okf_list_bundles");
    expect(parsed.tools).toContain("okf_search_concepts");
    expect(parsed.tools).toContain("okf_explain_diff");
    expect(parsed.prompts).toContain("draft_okf_concept");
  });

  it("describes only tools exposed by bundle config", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-mcp-cli-config-"));
    roots.push(root);
    await writeFile(join(root, "okfx.config.json"), JSON.stringify({
      mcp: {
        readonly: false,
        exposeGraph: false,
        exposeDiagnostics: false
      }
    }), "utf8");
    const output = capture();

    const code = await main(["mcp", root, "--describe"], output.io);
    const parsed = JSON.parse(output.stdout()) as { readonly: boolean; tools: string[] };

    expect(code).toBe(0);
    expect(parsed.readonly).toBe(false);
    expect(parsed.tools).toContain("okf_get_concept");
    expect(parsed.tools).not.toContain("okf_get_graph");
    expect(parsed.tools).not.toContain("okf_get_diagnostics");
  });
});
