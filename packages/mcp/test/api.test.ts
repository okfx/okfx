import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "@okfx/core";

import { createOkfBundleApi, createOkfMcpServer, getOkfMcpTools } from "../src/index.js";

describe("@okfx/mcp bundle API", () => {
  it("searches concepts and returns graph context", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-mcp-"));
    try {
      await mkdir(join(root, "metrics"), { recursive: true });
      await mkdir(join(root, "tables"), { recursive: true });
      await writeFile(join(root, "index.md"), "# Index\n[WAU](metrics/wau.md)\n", "utf8");
      await writeFile(join(root, "metrics/wau.md"), `---
type: Metric
title: Weekly Active Users
description: Demo metric.
---

# Weekly Active Users

[Events](../tables/events.md)
`, "utf8");
      await writeFile(join(root, "tables/events.md"), "---\ntype: Table\ntitle: Events\n---\n# Events\n", "utf8");

      const api = createOkfBundleApi(root);
      const bundles = await api.listBundles();

      expect(bundles[0]).toMatchObject({ id: "current", root, conceptCount: 2 });
      expect((await api.searchConcepts("weekly"))[0]).toMatchObject({ id: "metrics/wau" });
      expect(await api.getBacklinks("metrics/wau")).toEqual(["index"]);
      expect(await api.getNeighbors("metrics/wau")).toMatchObject({ outgoing: ["tables/events"] });
      expect((await api.getDiagnostics()).score).toBeLessThanOrEqual(100);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("explains semantic diffs against local comparison bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-mcp-diff-"));
    try {
      const before = join(root, "before");
      const after = join(root, "after");
      await mkdir(before, { recursive: true });
      await mkdir(after, { recursive: true });
      await writeFile(join(before, "concept.md"), "---\ntype: Note\ntitle: Concept\n---\n# Concept\n", "utf8");
      await writeFile(join(after, "concept.md"), "---\ntype: Note\ntitle: Updated Concept\n---\n# Concept\n\nMore context.\n", "utf8");
      await writeFile(join(after, "new.md"), "---\ntype: Note\ntitle: New\n---\n# New\n", "utf8");

      const api = createOkfBundleApi(after);
      const explanation = await api.explainDiff(before);

      expect(explanation.hasChanges).toBe(true);
      expect(explanation.summary).toBe("1 added, 0 removed, 0 renamed, 1 changed");
      expect(explanation.diff.addedConcepts).toEqual(["new"]);
      expect(explanation.diff.changedConcepts[0]?.id).toBe("concept");
      await expect(api.explainDiff(tmpdir())).rejects.toThrow("comparisonRoot must stay under");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects comparison roots that escape through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-mcp-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "okfx-mcp-outside-"));
    try {
      const current = join(root, "current");
      await mkdir(current);
      await writeFile(join(current, "concept.md"), "---\ntype: Note\ntitle: Current\n---\n# Current\n", "utf8");
      await writeFile(join(outside, "concept.md"), "---\ntype: Note\ntitle: Outside\n---\n# Outside\n", "utf8");
      await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

      await expect(createOkfBundleApi(current).explainDiff("../escape"))
        .rejects.toThrow("comparisonRoot must stay under");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("loads configured plugins when linting", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-mcp-config-"));
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Concept\n---\n# Concept\n", "utf8");
      await writeFile(join(root, "okfx.config.mjs"), `export default {
  plugins: ["./plugin.mjs"],
  rules: { "custom/mcp-rule": "error" }
};
`, "utf8");
      await writeFile(join(root, "plugin.mjs"), `export default {
  name: "mcp-test-plugin",
  rules: {
    "custom/mcp-rule": {
      run: () => [{ code: "custom/mcp-rule", severity: "warning", message: "MCP plugin ran." }]
    }
  }
};
`, "utf8");

      const lint = await createOkfBundleApi(root).lint();

      expect(lint.diagnostics.find((diagnostic) => diagnostic.code === "custom/mcp-rule")?.severity).toBe("error");
      expect(lint.plugins).toEqual([expect.objectContaining({ name: "mcp-test-plugin" })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters MCP tools using exposure config", () => {
    const tools = getOkfMcpTools(resolveConfig({
      mcp: {
        exposeGraph: false,
        exposeDiagnostics: false
      }
    }));

    expect(tools).toContain("okf_search_concepts");
    expect(tools).not.toContain("okf_get_graph");
    expect(tools).not.toContain("okf_get_diagnostics");
    expect(tools).not.toContain("okf_lint_bundle");
  });

  it("creates an MCP server", async () => {
    const server = await createOkfMcpServer({ root: process.cwd() });
    expect(server.isConnected()).toBe(false);
  });
});
