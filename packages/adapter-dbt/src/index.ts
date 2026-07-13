import {
  definePlugin,
  disambiguateGeneratedPaths,
  generationTimestamp,
  type OkfxGenerationOptions
} from "@okfx/plugin-api";

export interface DbtManifest {
  nodes?: Record<string, { resource_type?: string; name?: string; description?: string; depends_on?: { nodes?: string[] } }>;
}

export function produceDbtOkf(
  manifest: DbtManifest,
  options: OkfxGenerationOptions = {}
): Array<{ path: string; content: string }> {
  assertDbtManifest(manifest);
  const timestamp = generationTimestamp(options.now);
  return disambiguateGeneratedPaths(Object.entries(manifest.nodes ?? {})
    .filter(([, node]) => node.resource_type === "model")
    .map(([id, node]) => ({
      path: `tables/${slug(node.name ?? "model")}.md`,
      identity: id,
      content: concept(
        node.name ?? "dbt model",
        node.description ?? "Imported from dbt manifest.",
        node.depends_on?.nodes ?? [],
        timestamp
      )
    })))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export default definePlugin({
  name: "@okfx/adapter-dbt",
  adapters: {
    dbt: {
      async produce() {
        return [];
      }
    }
  }
});

function concept(title: string, description: string, dependsOn: string[], timestamp: string): string {
  return `---
type: Table
title: ${yamlScalar(title)}
description: ${yamlScalar(description)}
tags:
  - imported
  - dbt
timestamp: ${timestamp}
---

# ${title}

## Source Tables

${dependsOn.length === 0 ? "No upstream dbt dependencies declared." : dependsOn.map((item) => `- ${item}`).join("\n")}
`;
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!result) {
    throw new TypeError(`Could not derive a safe dbt model slug from ${JSON.stringify(value)}.`);
  }
  return result;
}

function assertDbtManifest(value: unknown): asserts value is DbtManifest {
  if (!isRecord(value)) {
    throw new TypeError("dbt adapter input must be an object.");
  }
  if (value.nodes !== undefined && !isRecord(value.nodes)) {
    throw new TypeError("dbt manifest nodes must be an object.");
  }

  for (const [id, node] of Object.entries(value.nodes ?? {})) {
    if (!isRecord(node)) {
      throw new TypeError(`dbt node ${JSON.stringify(id)} must be an object.`);
    }
    for (const field of ["resource_type", "name", "description"] as const) {
      if (node[field] !== undefined && typeof node[field] !== "string") {
        throw new TypeError(`dbt node ${JSON.stringify(id)} field ${field} must be a string.`);
      }
    }
    if (node.depends_on !== undefined) {
      if (!isRecord(node.depends_on) || (node.depends_on.nodes !== undefined && (!Array.isArray(node.depends_on.nodes) || node.depends_on.nodes.some((entry) => typeof entry !== "string")))) {
        throw new TypeError(`dbt node ${JSON.stringify(id)} depends_on.nodes must be an array of strings.`);
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
