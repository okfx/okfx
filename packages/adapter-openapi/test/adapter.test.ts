import { describe, expect, it } from "vitest";

import { produceOpenApiOkf } from "../src/index.js";

describe("@okfx/adapter-openapi", () => {
  it("produces API concepts", () => {
    const files = produceOpenApiOkf({ paths: { "/orders": { get: { summary: "List Orders" } } } });
    expect(files[0]).toMatchObject({ path: "apis/get-orders.md" });
    expect(files[0]?.content).toContain("type: API");
  });
});
