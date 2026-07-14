import { posix } from "node:path";

import { definePlugin } from "@okfx/plugin-api";
import { compareStrings, type BundleIR, type ConceptIR, type OkfxGraphIR } from "@okfx/core";

export interface StaticSiteFile {
  path: string;
  content: string;
}

export interface StaticSiteOptions {
  graph?: OkfxGraphIR;
  title?: string;
}

export function exportStaticSite(bundle: BundleIR, options: StaticSiteOptions = {}): StaticSiteFile[] {
  const title = options.title ?? "OKF Bundle";
  const conceptPages = new Map(bundle.concepts.map((concept) => [concept.id, conceptPagePath(concept.id)]));
  return [
    {
      path: "index.html",
      content: indexPage(bundle, title)
    },
    ...bundle.concepts.map((concept) => ({
      path: conceptPages.get(concept.id)!,
      content: conceptPage(concept, options.graph, title, conceptPages)
    })),
    ...(options.graph ? [{
      path: "graph.json",
      content: `${JSON.stringify(options.graph, null, 2)}\n`
    }] : [])
  ];
}

export default definePlugin({
  name: "@okfx/adapter-static-site",
  adapters: {
    "static-site": {
      async consume({ bundle, graph }) {
        return exportStaticSite(bundle, { graph });
      }
    }
  }
});

function indexPage(bundle: BundleIR, title: string): string {
  const concepts = [...bundle.concepts].sort((a, b) => compareStrings(a.id, b.id));
  return html(title, `
    <main>
      <h1>${escapeHtml(title)}</h1>
      <dl>
        <dt>Concepts</dt><dd>${bundle.stats.conceptCount}</dd>
        <dt>Links</dt><dd>${bundle.stats.linkCount}</dd>
        <dt>Broken links</dt><dd>${bundle.stats.brokenLinkCount}</dd>
      </dl>
      <h2>Concepts</h2>
      <ul>
        ${concepts.map((concept) => `<li><a href="${escapeAttribute(conceptPagePath(concept.id))}">${escapeHtml(concept.title ?? concept.id)}</a> <code>${escapeHtml(concept.type)}</code></li>`).join("\n")}
      </ul>
    </main>
  `);
}

function conceptPage(
  concept: ConceptIR,
  graph: OkfxGraphIR | undefined,
  title: string,
  conceptPages: Map<string, string>
): string {
  const currentPage = conceptPages.get(concept.id)!;
  const neighbors = uniqueSorted(graph?.edges
    .filter((edge) => edge.resolved && edge.source === concept.id)
    .map((edge) => edge.target) ?? []);
  const backlinks = uniqueSorted(graph?.analysis.backlinks[concept.id] ?? []);

  return html(`${concept.title ?? concept.id} - ${title}`, `
    <main>
      <p><a href="${escapeAttribute(relativeHref(currentPage, "index.html"))}">Index</a></p>
      <h1>${escapeHtml(concept.title ?? concept.id)}</h1>
      <dl>
        <dt>ID</dt><dd><code>${escapeHtml(concept.id)}</code></dd>
        <dt>Type</dt><dd>${escapeHtml(concept.type)}</dd>
        ${concept.description ? `<dt>Description</dt><dd>${escapeHtml(concept.description)}</dd>` : ""}
      </dl>
      <h2>Body</h2>
      <pre>${escapeHtml(concept.body.raw.trim())}</pre>
      <h2>Outgoing</h2>
      ${linkList(neighbors, currentPage, conceptPages)}
      <h2>Backlinks</h2>
      ${linkList(backlinks, currentPage, conceptPages)}
    </main>
  `);
}

function linkList(ids: string[], currentPage: string, conceptPages: Map<string, string>): string {
  if (ids.length === 0) {
    return "<p>None.</p>";
  }

  return `<ul>${ids.map((id) => {
    const targetPage = conceptPages.get(id);
    return targetPage
      ? `<li><a href="${escapeAttribute(relativeHref(currentPage, targetPage))}">${escapeHtml(id)}</a></li>`
      : `<li><code>${escapeHtml(id)}</code></li>`;
  }).join("")}</ul>`;
}

function conceptPagePath(id: string): string {
  return `concepts/${id.split("/").map(encodeURIComponent).join("/")}.html`;
}

function relativeHref(fromPage: string, toPage: string): string {
  return posix.relative(posix.dirname(fromPage), toPage) || posix.basename(toPage);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 2rem; max-width: 900px; }
    code, pre { background: #f4f4f4; border-radius: 4px; padding: 0.1rem 0.25rem; }
    pre { overflow: auto; padding: 1rem; }
    dt { font-weight: 700; }
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
