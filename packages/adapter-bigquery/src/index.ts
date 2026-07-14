import {
  definePlugin,
  compareStrings,
  disambiguateGeneratedPaths,
  escapeMarkdownText,
  generationTimestamp,
  markdownCodeSpan,
  type OkfxGenerationOptions
} from "@okfx/plugin-api";

export interface BigQueryTable {
  project: string;
  dataset: string;
  table: string;
  description?: string;
  columns?: Array<{ name: string; type?: string; description?: string }>;
}

export function produceBigQueryOkf(
  tables: BigQueryTable[],
  options: OkfxGenerationOptions = {}
): Array<{ path: string; content: string }> {
  assertBigQueryTables(tables);
  const timestamp = generationTimestamp(options.now);
  const normalizedTables = tables.map((table) => ({
    project: ownProperty(table, "project")!,
    dataset: ownProperty(table, "dataset")!,
    table: ownProperty(table, "table")!,
    description: ownProperty(table, "description"),
    columns: ownProperty(table, "columns")?.map((column) => ({
      name: ownProperty(column, "name")!,
      type: ownProperty(column, "type"),
      description: ownProperty(column, "description")
    }))
  }));
  return disambiguateGeneratedPaths(normalizedTables.map((table) => ({
    path: `tables/${slug(`${table.dataset}-${table.table}`, "table")}.md`,
    identity: `bigquery://${table.project}/${table.dataset}/${table.table}`,
    content: `---
type: Table
title: ${yamlScalar(`${table.dataset}.${table.table}`)}
description: ${yamlScalar(table.description ?? "Imported from BigQuery metadata.")}
resource: ${yamlScalar(`bigquery://${table.project}/${table.dataset}/${table.table}`)}
tags:
  - imported
  - bigquery
timestamp: ${timestamp}
---

# ${escapeMarkdownText(`${table.dataset}.${table.table}`)}

## Columns

${(table.columns ?? []).length === 0 ? "No columns provided." : table.columns!.map((column) => `- ${markdownCodeSpan(column.name)}${column.type ? ` (${escapeMarkdownText(column.type)})` : ""}${column.description ? `: ${escapeMarkdownText(column.description)}` : ""}`).join("\n")}
`
  }))).sort((a, b) => compareStrings(a.path, b.path));
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

function slug(value: string, fallback: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return result || fallback;
}

function assertBigQueryTables(value: unknown): asserts value is BigQueryTable[] {
  if (!Array.isArray(value)) {
    throw new TypeError("BigQuery adapter input must be an array.");
  }

  for (const [index, table] of value.entries()) {
    if (!isRecord(table)
      || !nonEmptyString(ownProperty(table, "project"))
      || !nonEmptyString(ownProperty(table, "dataset"))
      || !nonEmptyString(ownProperty(table, "table"))) {
      throw new TypeError(`BigQuery table at index ${index} must include non-empty string project, dataset, and table fields.`);
    }
    const description = ownProperty(table, "description");
    if (description !== undefined && typeof description !== "string") {
      throw new TypeError(`BigQuery table description at index ${index} must be a string.`);
    }
    const columns = ownProperty(table, "columns");
    if (columns !== undefined && !Array.isArray(columns)) {
      throw new TypeError(`BigQuery table columns at index ${index} must be an array.`);
    }
    for (const [columnIndex, column] of (columns ?? []).entries()) {
      if (!isRecord(column) || !nonEmptyString(ownProperty(column, "name"))) {
        throw new TypeError(`BigQuery column at table index ${index}, column index ${columnIndex} must include a non-empty string name.`);
      }
      for (const field of ["type", "description"] as const) {
        const fieldValue = ownProperty(column, field);
        if (fieldValue !== undefined && typeof fieldValue !== "string") {
          throw new TypeError(`BigQuery column ${field} at table index ${index}, column index ${columnIndex} must be a string.`);
        }
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
