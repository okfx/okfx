import { describe, expect, it } from "vitest";

import { produceDbtOkf } from "../src/index.js";

describe("@okfx/adapter-dbt", () => {
  it("produces table concepts from dbt models", () => {
    const files = produceDbtOkf(
      { nodes: { model: { resource_type: "model", name: "orders" } } },
      { now: new Date("2024-03-02T01:02:03Z") }
    );
    expect(files[0]).toMatchObject({ path: "tables/orders.md" });
    expect(files[0]?.content).toContain("type: Table");
    expect(files[0]?.content).toContain("timestamp: 2024-03-02T01:02:03.000Z");
  });
});
