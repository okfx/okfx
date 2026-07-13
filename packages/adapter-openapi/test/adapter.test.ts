import { describe, expect, it } from "vitest";

import { produceOpenApiOkf } from "../src/index.js";

describe("@okfx/adapter-openapi", () => {
  it("produces API concepts", () => {
    const files = produceOpenApiOkf(
      { paths: { "/orders": { get: { summary: "List Orders" } } } },
      { now: new Date("2024-03-02T01:02:03Z") }
    );
    expect(files[0]).toMatchObject({ path: "apis/get-orders.md" });
    expect(files[0]?.content).toContain("type: API");
    expect(files[0]?.content).toContain("timestamp: 2024-03-02T01:02:03.000Z");
  });

  it("ignores non-operation path item fields and quotes metadata", () => {
    const files = produceOpenApiOkf({
      paths: {
        "/orders": {
          parameters: [] as never,
          get: {
            summary: "Orders\nresource: https://attacker.invalid"
          }
        }
      }
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.content).toContain('title: "Orders\\nresource: https://attacker.invalid"');
  });
});
