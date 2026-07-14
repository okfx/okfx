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

  it("encodes hrefs separately from percent-encoded page filenames", () => {
    const bundle: BundleIR = {
      root: "/bundle",
      okfVersion: "0.1",
      concepts: [{
        id: "guides/my guide",
        path: "guides/my guide.md",
        type: "Note",
        title: "My Guide",
        frontmatter: { type: "Note", title: "My Guide" },
        body: { raw: "# My Guide\n", text: "My Guide", headings: [] },
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

    const files = exportStaticSite(bundle);
    const index = files.find((file) => file.path === "index.html")?.content ?? "";

    expect(files.map((file) => file.path)).toContain("concepts/guides/my%20guide.html");
    expect(index).toContain('href="concepts/guides/my%2520guide.html"');
  });

  it("produces portable, collision-free page paths for arbitrary concept IDs", () => {
    const concepts = ["CON", "Case", "case", "danger*"].map((id) => ({
      id,
      path: `${id}.md`,
      type: "Note",
      title: id,
      frontmatter: { type: "Note", title: id },
      body: { raw: `# ${id}\n`, text: id, headings: [] },
      links: [],
      contentHash: "hash"
    }));
    const bundle: BundleIR = {
      root: "/bundle",
      okfVersion: "0.1",
      concepts,
      indexes: [],
      logs: [],
      links: [],
      diagnostics: [],
      stats: {
        fileCount: concepts.length,
        conceptCount: concepts.length,
        indexCount: 0,
        logCount: 0,
        linkCount: 0,
        brokenLinkCount: 0,
        diagnosticCount: 0
      }
    };

    const files = exportStaticSite(bundle);
    const pagePaths = files.filter((file) => file.path !== "index.html").map((file) => file.path);
    const index = files.find((file) => file.path === "index.html")?.content ?? "";

    expect(pagePaths).toContain("concepts/%43ON.html");
    expect(pagePaths).toContain("concepts/danger%2A.html");
    expect(new Set(pagePaths.map((path) => path.normalize("NFC").toLowerCase())))
      .toHaveLength(concepts.length);
    expect(pagePaths.filter((path) => /concepts\/(?:Case|case)-[a-z0-9]{7}\.html/u.test(path)))
      .toHaveLength(2);
    expect(index).toContain('href="concepts/%2543ON.html"');
    expect(index).toContain('href="concepts/danger%252A.html"');
  });
});
