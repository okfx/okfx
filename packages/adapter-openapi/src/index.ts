import { definePlugin } from "@okfx/plugin-api";

export interface OpenApiDocument {
  info?: { title?: string; description?: string };
  paths?: Record<string, Record<string, { summary?: string; description?: string; operationId?: string }>>;
}

export function produceOpenApiOkf(document: OpenApiDocument): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  for (const [route, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      const id = operation.operationId ?? `${method}-${route}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
      const title = operation.summary ?? `${method.toUpperCase()} ${route}`;
      files.push({
        path: `apis/${slug(id)}.md`,
        content: concept("API", title, operation.description ?? document.info?.description ?? "Imported from OpenAPI.", [
          `# ${title}`,
          "",
          "## Usage",
          "",
          `- Method: \`${method.toUpperCase()}\``,
          `- Path: \`${route}\``,
          "",
          "## Auth Notes",
          "",
          "Document authentication requirements before publishing."
        ].join("\n"))
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export default definePlugin({
  name: "@okfx/adapter-openapi",
  adapters: {
    openapi: {
      async produce() {
        return [];
      }
    }
  }
});

function concept(type: string, title: string, description: string, body: string): string {
  return `---
type: ${type}
title: ${title}
description: ${description}
tags:
  - imported
  - openapi
timestamp: 2026-07-07T00:00:00Z
---

${body}
`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
