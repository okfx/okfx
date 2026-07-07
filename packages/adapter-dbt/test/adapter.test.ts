import { describe, expect, it } from "vitest";

import { produceDbtOkf } from "../src/index.js";

describe("@okfx/adapter-dbt", () => {
  it("produces table concepts from dbt models", () => {
    const files = produceDbtOkf({ nodes: { model: { resource_type: "model", name: "orders" } } });
    expect(files[0]).toMatchObject({ path: "tables/orders.md" });
    expect(files[0]?.content).toContain("type: Table");
  });
});
