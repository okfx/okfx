import { describe, expect, it } from "vitest";

import { produceDataHubOkf } from "../src/index.js";

describe("@okfx/adapter-datahub", () => {
  it("produces dataset concepts", () => {
    const files = produceDataHubOkf(
      [{ urn: "urn:li:dataset:(snowflake,orders,PROD)", name: "orders", platform: "snowflake" }],
      { now: new Date("2024-03-02T01:02:03Z") }
    );
    expect(files[0]).toMatchObject({ path: "catalog/orders.md" });
    expect(files[0]?.content).toContain("type: Dataset");
    expect(files[0]?.content).toContain("timestamp: 2024-03-02T01:02:03.000Z");
  });
});
