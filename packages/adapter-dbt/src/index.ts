import {
  definePlugin,
  compareStrings,
  disambiguateGeneratedPaths,
  escapeMarkdownText,
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
  const nodes = ownProperty(manifest, "nodes") ?? {};
  return disambiguateGeneratedPaths(Object.entries(nodes)
    .filter(([, node]) => ownProperty(node, "resource_type") === "model")
    .map(([id, node]) => {
      const name = ownProperty(node, "name");
      const description = ownProperty(node, "description");
      const dependsOn = ownProperty(node, "depends_on");
      return {
        path: `tables/${slug(name ?? "model", "model")}.md`,
        identity: id,
        content: concept(
          name ?? "dbt model",
          description ?? "Imported from dbt manifest.",
          dependsOn ? ownProperty(dependsOn, "nodes") ?? [] : [],
          timestamp
        )
      };
    }))
    .sort((a, b) => compareStrings(a.path, b.path));
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

# ${escapeMarkdownText(title)}

## Source Tables

${dependsOn.length === 0 ? "No upstream dbt dependencies declared." : dependsOn.map((item) => `- ${escapeMarkdownText(item)}`).join("\n")}
`;
}

function slug(value: string, fallback: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return result || fallback;
}

function assertDbtManifest(value: unknown): asserts value is DbtManifest {
  if (!isRecord(value)) {
    throw new TypeError("dbt adapter input must be an object.");
  }
  const nodes = ownProperty(value, "nodes");
  if (nodes !== undefined && !isRecord(nodes)) {
    throw new TypeError("dbt manifest nodes must be an object.");
  }

  for (const [id, node] of Object.entries(nodes ?? {})) {
    if (!isRecord(node)) {
      throw new TypeError(`dbt node ${JSON.stringify(id)} must be an object.`);
    }
    for (const field of ["resource_type", "name", "description"] as const) {
      const fieldValue = ownProperty(node, field);
      if (fieldValue !== undefined && typeof fieldValue !== "string") {
        throw new TypeError(`dbt node ${JSON.stringify(id)} field ${field} must be a string.`);
      }
    }
    const dependsOn = ownProperty(node, "depends_on");
    if (dependsOn !== undefined) {
      const dependencyNodes = isRecord(dependsOn) ? ownProperty(dependsOn, "nodes") : undefined;
      if (!isRecord(dependsOn) || (dependencyNodes !== undefined && (!Array.isArray(dependencyNodes) || Array.from(dependencyNodes).some((entry) => typeof entry !== "string")))) {
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

function ownProperty<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
