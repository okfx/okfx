import { describe, expect, it } from "vitest";

import { produceBigQueryOkf } from "../src/index.js";

describe("@okfx/adapter-bigquery", () => {
  it("produces table concepts", () => {
    const files = produceBigQueryOkf([{ project: "p", dataset: "d", table: "orders" }]);
    expect(files[0]).toMatchObject({ path: "tables/d-orders.md" });
    expect(files[0]?.content).toContain("bigquery://p/d/orders");
  });
});
