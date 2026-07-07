import { describe, expect, it } from "vitest";

import { buildGraph, type BundleIR } from "@okfx/core";

import { exportStaticSite } from "../src/index.js";

describe("@okfx/adapter-static-site", () => {
  it("exports index, concept pages, and graph json", () => {
    const bundle: BundleIR = {
      root: "/bundle",
      okfVersion: "0.1",
      concepts: [{
        id: "metrics/wau",
        path: "metrics/wau.md",
        type: "Metric",
        title: "Weekly Active Users",
        description: "Demo metric.",
        frontmatter: { type: "Metric" },
        body: {
          raw: "# Weekly Active Users\n",
          text: "Weekly Active Users",
          headings: []
        },
        links: [],
        contentHash: "hash"
      }],
      indexes: [],
      logs: [],
      links: [],
      diagnostics: [],
      stats: {
        fileCount: 1,
        conceptCount: 1,
        indexCount: 0,
        logCount: 0,
        linkCount: 0,
        brokenLinkCount: 0,
        diagnosticCount: 0
      }
    };

    const files = exportStaticSite(bundle, { graph: buildGraph(bundle), title: "Knowledge" });

    expect(files.map((file) => file.path).sort()).toEqual([
      "concepts/metrics/wau.html",
      "graph.json",
      "index.html"
    ]);
    expect(files.find((file) => file.path === "index.html")?.content).toContain("Weekly Active Users");
    expect(files.find((file) => file.path === "graph.json")?.content).toContain("\"nodes\"");
  });
});
