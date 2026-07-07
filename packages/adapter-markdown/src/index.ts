import { definePlugin } from "@okfx/plugin-api";

export interface MarkdownSource {
  path: string;
  title?: string;
  body: string;
  tags?: string[];
}

export interface ProducedOkfFile {
  path: string;
  content: string;
}

export function produceMarkdownOkf(sources: MarkdownSource[]): ProducedOkfFile[] {
  return sources.map((source) => ({
    path: normalizeConceptPath(source.path),
    content: concept({
      type: "Note",
      title: source.title ?? titleFromPath(source.path),
      description: `Imported from ${source.path}.`,
      tags: source.tags ?? ["imported"],
      body: source.body
    })
  }));
}

export default definePlugin({
  name: "@okfx/adapter-markdown",
  adapters: {
    markdown: {
      async produce() {
        return [];
      }
    }
  }
});

function normalizeConceptPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.?\//, "");
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

function titleFromPath(path: string): string {
  return path
    .split(/[/.]/)
    .filter(Boolean)
    .at(-1)!
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function concept(input: { type: string; title: string; description: string; tags: string[]; body: string }): string {
  return `---
type: ${input.type}
title: ${input.title}
description: ${input.description}
tags:
${input.tags.map((tag) => `  - ${tag}`).join("\n")}
timestamp: 2026-07-07T00:00:00Z
---

${input.body.replace(/\s*$/g, "")}
`;
}
