import {
  definePlugin,
  compareStrings,
  disambiguateGeneratedPaths,
  escapeMarkdownText,
  generationTimestamp,
  markdownCodeSpan,
  type OkfxGenerationOptions
} from "@okfx/plugin-api";

export interface DataHubEntity {
  urn: string;
  name?: string;
  description?: string;
  platform?: string;
}

export function produceDataHubOkf(
  entities: DataHubEntity[],
  options: OkfxGenerationOptions = {}
): Array<{ path: string; content: string }> {
  assertDataHubEntities(entities);
  const timestamp = generationTimestamp(options.now);
  const normalizedEntities = entities.map((entity) => ({
    urn: ownProperty(entity, "urn")!,
    name: ownProperty(entity, "name"),
    description: ownProperty(entity, "description"),
    platform: ownProperty(entity, "platform")
  }));
  return disambiguateGeneratedPaths(normalizedEntities.map((entity) => ({
    path: `catalog/${slug(entity.name ?? entity.urn, "dataset")}.md`,
    identity: entity.urn,
    content: `---
type: Dataset
title: ${yamlScalar(entity.name ?? entity.urn)}
description: ${yamlScalar(entity.description ?? "Imported from DataHub metadata.")}
resource: ${yamlScalar(entity.urn)}
tags:
  - imported
  - datahub
  - ${yamlScalar(slug(entity.platform ?? "dataset", "dataset"))}
timestamp: ${timestamp}
---

# ${escapeMarkdownText(entity.name ?? entity.urn)}

DataHub URN: ${markdownCodeSpan(entity.urn)}
`
  }))).sort((a, b) => compareStrings(a.path, b.path));
}

export default definePlugin({
  name: "@okfx/adapter-datahub",
  adapters: {
    datahub: {
      async produce() {
        return [];
      }
    }
  }
});

function slug(value: string, fallback: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return result || fallback;
}

function assertDataHubEntities(value: unknown): asserts value is DataHubEntity[] {
  if (!Array.isArray(value)) {
    throw new TypeError("DataHub adapter input must be an array.");
  }

  for (const [index, entity] of value.entries()) {
    if (!isRecord(entity) || !nonEmptyString(ownProperty(entity, "urn"))) {
      throw new TypeError(`DataHub entity at index ${index} must include a non-empty string urn.`);
    }
    for (const field of ["name", "description", "platform"] as const) {
      const fieldValue = ownProperty(entity, field);
      if (fieldValue !== undefined && typeof fieldValue !== "string") {
        throw new TypeError(`DataHub entity ${field} at index ${index} must be a string.`);
      }
    }
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownProperty<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
