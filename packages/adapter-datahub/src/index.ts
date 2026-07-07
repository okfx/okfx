import { definePlugin } from "@okfx/plugin-api";

export interface DataHubEntity {
  urn: string;
  name?: string;
  description?: string;
  platform?: string;
}

export function produceDataHubOkf(entities: DataHubEntity[]): Array<{ path: string; content: string }> {
  return entities.map((entity) => ({
    path: `catalog/${slug(entity.name ?? entity.urn)}.md`,
    content: `---
type: Dataset
title: ${entity.name ?? entity.urn}
description: ${entity.description ?? "Imported from DataHub metadata."}
resource: ${entity.urn}
tags:
  - imported
  - datahub
  - ${slug(entity.platform ?? "dataset")}
timestamp: 2026-07-07T00:00:00Z
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
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
