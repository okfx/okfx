import { describe, expect, it } from "vitest";

import { produceBigQueryOkf } from "../src/index.js";

describe("@okfx/adapter-bigquery", () => {
  it("produces table concepts", () => {
    const files = produceBigQueryOkf(
      [{ project: "p", dataset: "d", table: "orders" }],
      { now: new Date("2024-03-02T01:02:03Z") }
    );
    expect(files[0]).toMatchObject({ path: "tables/d-orders.md" });
    expect(files[0]?.content).toContain("bigquery://p/d/orders");
    expect(files[0]?.content).toContain("timestamp: 2024-03-02T01:02:03.000Z");
  });

  it.each(["type", "description"] as const)("rejects a non-string column %s", (field) => {
    expect(() => produceBigQueryOkf([{
      project: "p",
      dataset: "d",
      table: "orders",
      columns: [{ name: "id", [field]: { injected: true } }] as never
    }])).toThrow(`BigQuery column ${field} at table index 0, column index 0 must be a string`);
  });
});
