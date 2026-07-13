import { describe, expect, it } from "vitest";

import { buildGraph, type BundleIR } from "@okfx/core";

import { exportStaticSite } from "../src/index.js";

describe("@okfx/adapter-static-site", () => {
  it("exports index, concept pages, and graph json", () => {
    const conceptLink = {
      sourceConceptId: "metrics/wau",
      targetRaw: "../tables/events.md",
      targetConceptId: "tables/events",
      text: "Events",
      kind: "internal" as const,
      resolved: true,
      location: { start: { line: 1, column: 1 } }
    };
    const bundle: BundleIR = {
      root: "/bundle",
      okfVersion: "0.1",
      concepts: [{
        id: "metrics/wau",
        path: "metrics/wau.md",
        type: "Metric",
        title: "Weekly Active Users",
        description: "Demo metric.",
        resource: "https://example.com/metrics/wau",
        tags: ["analytics"],
        frontmatter: { type: "Metric", resource: "https://example.com/metrics/wau", tags: ["analytics"] },
        body: {
          raw: "# Weekly Active Users\n",
          text: "Weekly Active Users",
          headings: []
        },
        links: [conceptLink],
        contentHash: "hash"
      }, {
        id: "tables/events",
        path: "tables/events.md",
        type: "Table",
        title: "Events",
        frontmatter: { type: "Table" },
        body: {
          raw: "# Events\n",
          text: "Events",
          headings: []
        },
        links: [],
        contentHash: "hash"
      }],
      indexes: [],
      logs: [],
      links: [conceptLink],
      diagnostics: [],
      stats: {
        fileCount: 2,
        conceptCount: 2,
        indexCount: 0,
        logCount: 0,
        linkCount: 1,
        brokenLinkCount: 0,
        diagnosticCount: 0
      }
    };

    const files = exportStaticSite(bundle, { graph: buildGraph(bundle), title: "Knowledge" });

    expect(files.map((file) => file.path).sort()).toEqual([
      "concepts/metrics/wau.html",
      "concepts/tables/events.html",
      "graph.json",
      "index.html"
    ]);
    expect(files.find((file) => file.path === "index.html")?.content).toContain("Weekly Active Users");
    expect(files.find((file) => file.path === "graph.json")?.content).toContain("\"nodes\"");
    const metricPage = files.find((file) => file.path === "concepts/metrics/wau.html")?.content ?? "";
    const tablePage = files.find((file) => file.path === "concepts/tables/events.html")?.content ?? "";
    expect(metricPage).toContain('href="../../index.html"');
    expect(metricPage).toContain('href="../tables/events.html"');
    expect(metricPage).toContain("<code>resource:https://example.com/metrics/wau</code>");
    expect(metricPage).not.toContain('href="../resource:');
    expect(metricPage).toContain("<code>tag:analytics</code>");
    expect(tablePage).toContain('href="../metrics/wau.html"');
  });
});
