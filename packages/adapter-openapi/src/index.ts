import {
  definePlugin,
  compareStrings,
  disambiguateGeneratedPaths,
  escapeMarkdownText,
  generationTimestamp,
  markdownCodeSpan,
  type OkfxGenerationOptions
} from "@okfxjs/plugin-api";

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
  const files: Array<{ path: string; content: string; identity: string }> = [];
  const paths = ownProperty(document, "paths") ?? {};
  const info = ownProperty(document, "info");
  const infoDescription = info ? ownProperty(info, "description") : undefined;
  for (const [route, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) {
        continue;
      }
      const id = ownProperty(operation, "operationId")
        ?? `${method}-${route}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
      const title = ownProperty(operation, "summary") ?? `${method.toUpperCase()} ${route}`;
      files.push({
        path: `apis/${slug(id, "operation")}.md`,
        identity: `${method.toLowerCase()} ${route}`,
        content: concept("API", title, ownProperty(operation, "description") ?? infoDescription ?? "Imported from OpenAPI.", [
          `# ${escapeMarkdownText(title)}`,
          "",
          "## Usage",
          "",
          `- Method: ${markdownCodeSpan(method.toUpperCase())}`,
          `- Path: ${markdownCodeSpan(route)}`,
          "",
          "## Auth Notes",
          "",
          "Document authentication requirements before publishing."
        ].join("\n"), timestamp)
      });
    }
  }
  return disambiguateGeneratedPaths(files).sort((a, b) => compareStrings(a.path, b.path));
}

export default definePlugin({
  name: "@okfxjs/adapter-openapi",
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

function slug(value: string, fallback: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return result || fallback;
}

function assertOpenApiDocument(value: unknown): asserts value is OpenApiDocument {
  if (!isRecord(value)) {
    throw new TypeError("OpenAPI adapter input must be an object.");
  }
  const info = ownProperty(value, "info");
  if (info !== undefined && !isRecord(info)) {
    throw new TypeError("OpenAPI info must be an object.");
  }
  for (const field of ["title", "description"] as const) {
    const fieldValue = isRecord(info) ? ownProperty(info, field) : undefined;
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      throw new TypeError(`OpenAPI info field ${field} must be a string.`);
    }
  }
  const paths = ownProperty(value, "paths");
  if (paths !== undefined && !isRecord(paths)) {
    throw new TypeError("OpenAPI paths must be an object.");
  }

  for (const [route, pathItem] of Object.entries(paths ?? {})) {
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
        const fieldValue = ownProperty(operation, field);
        if (fieldValue !== undefined && typeof fieldValue !== "string") {
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

function ownProperty<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
