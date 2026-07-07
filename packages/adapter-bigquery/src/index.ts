import { definePlugin } from "@okfx/plugin-api";

export interface BigQueryTable {
  project: string;
  dataset: string;
  table: string;
  description?: string;
  columns?: Array<{ name: string; type?: string; description?: string }>;
}

export function produceBigQueryOkf(tables: BigQueryTable[]): Array<{ path: string; content: string }> {
  return tables.map((table) => ({
    path: `tables/${slug(`${table.dataset}-${table.table}`)}.md`,
    content: `---
type: Table
title: ${table.dataset}.${table.table}
description: ${table.description ?? "Imported from BigQuery metadata."}
resource: bigquery://${table.project}/${table.dataset}/${table.table}
tags:
  - imported
  - bigquery
timestamp: 2026-07-07T00:00:00Z
---

# ${table.dataset}.${table.table}

## Columns

${(table.columns ?? []).length === 0 ? "No columns provided." : table.columns!.map((column) => `- \`${column.name}\`${column.type ? ` (${column.type})` : ""}${column.description ? `: ${column.description}` : ""}`).join("\n")}
`
  })).sort((a, b) => a.path.localeCompare(b.path));
}

export default definePlugin({
  name: "@okfx/adapter-bigquery",
  adapters: {
    bigquery: {
      async produce() {
        return [];
      }
    }
  }
});

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
