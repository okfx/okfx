import { definePlugin, generationTimestamp, type OkfxGenerationOptions } from "@okfx/plugin-api";

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
  return entities.map((entity) => ({
    path: `catalog/${slug(entity.name ?? entity.urn)}.md`,
    content: `---
type: Dataset
title: ${yamlScalar(entity.name ?? entity.urn)}
description: ${yamlScalar(entity.description ?? "Imported from DataHub metadata.")}
resource: ${yamlScalar(entity.urn)}
tags:
  - imported
  - datahub
  - ${yamlScalar(slug(entity.platform ?? "dataset"))}
timestamp: ${timestamp}
---

# ${entity.name ?? entity.urn}

DataHub URN: \`${entity.urn}\`
`
  })).sort((a, b) => a.path.localeCompare(b.path));
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

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!result) {
    throw new TypeError(`Could not derive a safe DataHub slug from ${JSON.stringify(value)}.`);
  }
  return result;
}

function assertDataHubEntities(value: unknown): asserts value is DataHubEntity[] {
  if (!Array.isArray(value)) {
    throw new TypeError("DataHub adapter input must be an array.");
  }

  for (const [index, entity] of value.entries()) {
    if (!isRecord(entity) || !nonEmptyString(entity.urn)) {
      throw new TypeError(`DataHub entity at index ${index} must include a non-empty string urn.`);
    }
    for (const field of ["name", "description", "platform"] as const) {
      if (entity[field] !== undefined && typeof entity[field] !== "string") {
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
