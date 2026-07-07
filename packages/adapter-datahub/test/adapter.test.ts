import { describe, expect, it } from "vitest";

import { produceDataHubOkf } from "../src/index.js";

describe("@okfx/adapter-datahub", () => {
  it("produces dataset concepts", () => {
    const files = produceDataHubOkf([{ urn: "urn:li:dataset:(snowflake,orders,PROD)", name: "orders", platform: "snowflake" }]);
    expect(files[0]).toMatchObject({ path: "catalog/orders.md" });
    expect(files[0]?.content).toContain("type: Dataset");
  });
});
