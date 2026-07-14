import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

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

  it("prints SARIF output", async () => {
    const parent = await tempRoot();
    const root = join(parent, "bundle with spaces");
    await mkdir(root);
    await write(root, "concept # one.md", "---\ntype: Note\n---\n# Concept\n");
    const output = capture();

    const code = await main(["lint", root, "--format", "sarif"], output.io);
    const parsed = JSON.parse(output.stdout()) as {
      version: string;
      runs: Array<{
        originalUriBaseIds: { BUNDLE_ROOT: { uri: string } };
        results: Array<{
          ruleId: string;
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
        }>;
      }>;
    };

    expect(code).toBe(0);
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.runs[0]?.originalUriBaseIds.BUNDLE_ROOT.uri)
      .toBe(pathToFileURL(`${root}${sep}`).href);
    expect(parsed.runs[0]?.results.map((result) => result.ruleId)).toContain("hygiene/missing-title");
    expect(parsed.runs[0]?.results
      .find((result) => result.ruleId === "hygiene/missing-title")
      ?.locations[0]?.physicalLocation.artifactLocation.uri)
      .toBe("concept%20%23%20one.md");
  });

  it("prints debug and trace output to stderr", async () => {
    const root = await tempRoot();
    await write(root, "concept.md", "---\ntype: Note\n---\n# Concept\n");
    const output = capture();

    const code = await main(["lint", root, "--debug", "--trace", "--timings"], output.io);

    expect(code).toBe(0);
    expect(output.stderr()).toContain("okfx debug:");
    expect(output.stderr()).toContain("filesScanned: 1");
    expect(output.stderr()).toContain("diagnostics:");
  });

  it("fails on suspicious secrets", async () => {
    const root = await tempRoot();
    await write(root, "concept.md", "---\ntype: Note\ntitle: Concept\ndescription: Demo\n---\napi_key = abcdefghijklmnopqrstuvwxyz\n");
    const output = capture();

    const code = await main(["lint", root], output.io);

    expect(code).toBe(1);
    expect(output.stdout()).toContain("security/suspicious-secret");
  });

  it("loads configured plugin rules and supports --no-plugins", async () => {
    const root = await tempRoot();
    await write(root, "okfx.config.ts", "export default { plugins: ['./owner-plugin.ts'] };\n");
    await write(root, "owner-plugin.ts", `export default {
  name: "owner-plugin",
  version: "1.0.0",
  rules: {
    "custom/owner-required": {
      meta: {
        description: "Concepts must declare an owner.",
        defaultSeverity: "warning"
      },
      run({ bundle }) {
        return bundle.concepts
          .filter((concept) => typeof concept.frontmatter.owner !== "string")
          .map((concept) => ({
            code: "custom/owner-required",
            severity: "warning",
            message: "Concept should declare an owner.",
            path: concept.path,
            conceptId: concept.id
          }));
      }
    }
  }
};
`);
    await write(root, "concept.md", "---\ntype: Note\ntitle: Concept\ndescription: Demo\n---\n# Concept\n");

    const withPlugins = capture();
    const withPluginsCode = await main(["lint", root], withPlugins.io);

    expect(withPluginsCode).toBe(0);
    expect(withPlugins.stdout()).toContain("plugins: owner-plugin@1.0.0");
    expect(withPlugins.stdout()).toContain("custom/owner-required");

    const withoutPlugins = capture();
    const withoutPluginsCode = await main(["lint", root, "--no-plugins"], withoutPlugins.io);

    expect(withoutPluginsCode).toBe(0);
    expect(withoutPlugins.stdout()).toContain("plugins: none");
    expect(withoutPlugins.stdout()).not.toContain("custom/owner-required");
  });

  it("returns exit code 3 for plugin failures", async () => {
    const root = await tempRoot();
    await write(root, "okfx.config.ts", "export default { plugins: ['./missing-plugin.ts'] };\n");
    await write(root, "concept.md", "---\ntype: Note\ntitle: Concept\ndescription: Demo\n---\n# Concept\n");
    const output = capture();

    const code = await main(["lint", root], output.io);

    expect(code).toBe(3);
    expect(output.stdout()).toContain("plugin/load-failed");
  });

  it("does not treat plugin-namespaced rule diagnostics as runtime failures", async () => {
    const root = await tempRoot();
    await write(root, "okfx.config.ts", "export default { plugins: ['./policy-plugin.ts'] };\n");
    await write(root, "policy-plugin.ts", `export default {
  name: "policy-plugin",
  rules: {
    "plugin/policy": {
      run: () => [{ message: "Policy advice." }]
    }
  }
};
`);
    await write(root, "concept.md", "---\ntype: Note\ntitle: Concept\ndescription: Demo\n---\n# Concept\n");
    const output = capture();

    const code = await main(["lint", root], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toContain("plugin/policy");
  });
});
