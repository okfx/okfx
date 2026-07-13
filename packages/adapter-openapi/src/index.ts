import { definePlugin, generationTimestamp, type OkfxGenerationOptions } from "@okfx/plugin-api";

export interface OpenApiDocument {
  info?: { title?: string; description?: string };
  paths?: Record<string, Record<string, { summary?: string; description?: string; operationId?: string }>>;
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

export function produceOpenApiOkf(
  document: OpenApiDocument,
  options: OkfxGenerationOptions = {}
): Array<{ path: string; content: string }> {
  assertOpenApiDocument(document);
  const timestamp = generationTimestamp(options.now);
  const files: Array<{ path: string; content: string }> = [];
  for (const [route, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) {
        continue;
      }
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
        ].join("\n"), timestamp)
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

function concept(type: string, title: string, description: string, body: string, timestamp: string): string {
  return `---
type: ${type}
title: ${yamlScalar(title)}
description: ${yamlScalar(description)}
tags:
  - imported
  - openapi
timestamp: ${timestamp}
---

${body}
`;
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!result) {
    throw new TypeError(`Could not derive a safe OpenAPI operation slug from ${JSON.stringify(value)}.`);
  }
  return result;
}

function assertOpenApiDocument(value: unknown): asserts value is OpenApiDocument {
  if (!isRecord(value)) {
    throw new TypeError("OpenAPI adapter input must be an object.");
  }
  if (value.info !== undefined && !isRecord(value.info)) {
    throw new TypeError("OpenAPI info must be an object.");
  }
  if (value.paths !== undefined && !isRecord(value.paths)) {
    throw new TypeError("OpenAPI paths must be an object.");
  }

  for (const [route, pathItem] of Object.entries(value.paths ?? {})) {
    if (!isRecord(pathItem)) {
      throw new TypeError(`OpenAPI path item ${JSON.stringify(route)} must be an object.`);
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) {
        continue;
      }
      if (!isRecord(operation)) {
        throw new TypeError(`OpenAPI operation ${method.toUpperCase()} ${route} must be an object.`);
      }
      for (const field of ["summary", "description", "operationId"] as const) {
        if (operation[field] !== undefined && typeof operation[field] !== "string") {
          throw new TypeError(`OpenAPI operation ${method.toUpperCase()} ${route} field ${field} must be a string.`);
        }
      }
    }
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
