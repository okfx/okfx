import { definePlugin } from "@okfx/plugin-api";

export interface BigQueryTable {
  project: string;
  dataset: string;
  table: string;
  description?: string;
  columns?: Array<{ name: string; type?: string; description?: string }>;
}

export function produceBigQueryOkf(tables: BigQueryTable[]): Array<{ path: string; content: string }> {
  assertBigQueryTables(tables);
  return tables.map((table) => ({
    path: `tables/${slug(`${table.dataset}-${table.table}`)}.md`,
    content: `---
type: Table
title: ${yamlScalar(`${table.dataset}.${table.table}`)}
description: ${yamlScalar(table.description ?? "Imported from BigQuery metadata.")}
resource: ${yamlScalar(`bigquery://${table.project}/${table.dataset}/${table.table}`)}
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
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!result) {
    throw new TypeError(`Could not derive a safe BigQuery table slug from ${JSON.stringify(value)}.`);
  }
  return result;
}

function assertBigQueryTables(value: unknown): asserts value is BigQueryTable[] {
  if (!Array.isArray(value)) {
    throw new TypeError("BigQuery adapter input must be an array.");
  }

  for (const [index, table] of value.entries()) {
    if (!isRecord(table) || !nonEmptyString(table.project) || !nonEmptyString(table.dataset) || !nonEmptyString(table.table)) {
      throw new TypeError(`BigQuery table at index ${index} must include non-empty string project, dataset, and table fields.`);
    }
    if (table.description !== undefined && typeof table.description !== "string") {
      throw new TypeError(`BigQuery table description at index ${index} must be a string.`);
    }
    if (table.columns !== undefined && (!Array.isArray(table.columns) || table.columns.some((column) => !isRecord(column) || !nonEmptyString(column.name)))) {
      throw new TypeError(`BigQuery table columns at index ${index} must include non-empty string names.`);
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
