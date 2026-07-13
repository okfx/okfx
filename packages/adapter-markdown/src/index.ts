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
  assertMarkdownSources(sources);
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
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const withExtension = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  const segments: string[] = [];

  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || /^[A-Za-z]:\//.test(normalized)) {
    throw new TypeError(`Markdown source path must be a non-empty relative path: ${JSON.stringify(path)}`);
  }

  for (const segment of withExtension.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        throw new TypeError(`Markdown source path escapes the output root: ${JSON.stringify(path)}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw new TypeError(`Markdown source path must identify a file: ${JSON.stringify(path)}`);
  }

  return segments.join("/");
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
title: ${yamlScalar(input.title)}
description: ${yamlScalar(input.description)}
tags:
${input.tags.map((tag) => `  - ${yamlScalar(tag)}`).join("\n")}
timestamp: 2026-07-07T00:00:00Z
---

${input.body.replace(/\s*$/g, "")}
`;
}

function assertMarkdownSources(value: unknown): asserts value is MarkdownSource[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Markdown adapter input must be an array.");
  }

  for (const [index, source] of value.entries()) {
    if (!isRecord(source) || typeof source.path !== "string" || typeof source.body !== "string") {
      throw new TypeError(`Markdown source at index ${index} must include string path and body fields.`);
    }
    if (source.title !== undefined && typeof source.title !== "string") {
      throw new TypeError(`Markdown source title at index ${index} must be a string.`);
    }
    if (source.tags !== undefined && (!Array.isArray(source.tags) || source.tags.some((tag) => typeof tag !== "string"))) {
      throw new TypeError(`Markdown source tags at index ${index} must be an array of strings.`);
    }
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
