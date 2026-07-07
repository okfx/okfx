import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createOkfBundleApi, createOkfMcpServer } from "../src/index.js";

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

      expect((await api.searchConcepts("weekly"))[0]).toMatchObject({ id: "metrics/wau" });
      expect(await api.getBacklinks("metrics/wau")).toEqual(["index"]);
      expect(await api.getNeighbors("metrics/wau")).toMatchObject({ outgoing: ["tables/events"] });
      expect((await api.getDiagnostics()).score).toBeLessThanOrEqual(100);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates an MCP server", () => {
    const server = createOkfMcpServer({ root: process.cwd() });
    expect(server.isConnected()).toBe(false);
  });
});
