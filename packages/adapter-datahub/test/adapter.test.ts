import { describe, expect, it } from "vitest";

import { parseMarkdownDocument } from "@okfx/core";

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

  it("disambiguates entities that share a display name", () => {
    const files = produceDataHubOkf([
      { urn: "urn:li:dataset:(snowflake,orders,PROD)", name: "orders" },
      { urn: "urn:li:dataset:(bigquery,orders,PROD)", name: "orders" }
    ]);

    expect(new Set(files.map((file) => file.path))).toHaveLength(2);
    expect(files.every((file) => file.path.startsWith("catalog/orders-"))).toBe(true);
  });

  it("does not turn imported entity metadata into Markdown links", () => {
    const [file] = produceDataHubOkf([{
      urn: "urn:test:` [Injected](evil.md)",
      name: "[Dataset](other.md)"
    }]);

    expect(parseMarkdownDocument(file!.path, file!.content, "dataset").links).toEqual([]);
  });

  it("uses safe fallbacks for Unicode-only names and platforms", () => {
    const [file] = produceDataHubOkf([{
      urn: "urn:li:dataset:orders",
      name: "\u8ba2\u5355\u6570\u636e",
      platform: "\u6570\u636e\u5e73\u53f0"
    }]);

    expect(file?.path).toBe("catalog/dataset.md");
    expect(file?.content).toContain('  - "dataset"');
  });
});
