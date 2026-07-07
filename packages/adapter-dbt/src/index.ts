import { definePlugin } from "@okfx/plugin-api";

export interface DbtManifest {
  nodes?: Record<string, { resource_type?: string; name?: string; description?: string; depends_on?: { nodes?: string[] } }>;
}

export function produceDbtOkf(manifest: DbtManifest): Array<{ path: string; content: string }> {
  return Object.values(manifest.nodes ?? {})
    .filter((node) => node.resource_type === "model")
    .map((node) => ({
      path: `tables/${slug(node.name ?? "model")}.md`,
      content: concept(node.name ?? "dbt model", node.description ?? "Imported from dbt manifest.", node.depends_on?.nodes ?? [])
    }))
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

function concept(title: string, description: string, dependsOn: string[]): string {
  return `---
type: Table
title: ${title}
description: ${description}
tags:
  - imported
  - dbt
timestamp: 2026-07-07T00:00:00Z
---

# ${title}

## Source Tables

${dependsOn.length === 0 ? "No upstream dbt dependencies declared." : dependsOn.map((item) => `- ${item}`).join("\n")}
`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
