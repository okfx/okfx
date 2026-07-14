import { describe, expect, it } from "vitest";

import { parseMarkdownDocument } from "@okfx/core";

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

  it("disambiguates models that share a name", () => {
    const files = produceDbtOkf({
      nodes: {
        "model.a.orders": { resource_type: "model", name: "orders" },
        "model.b.orders": { resource_type: "model", name: "orders" }
      }
    });

    expect(new Set(files.map((file) => file.path))).toHaveLength(2);
    expect(files.every((file) => file.path.startsWith("tables/orders-"))).toBe(true);
  });

  it("does not turn imported model metadata into Markdown links", () => {
    const [file] = produceDbtOkf({
      nodes: {
        model: {
          resource_type: "model",
          name: "[Orders](evil.md)",
          depends_on: { nodes: ["[Source](other.md)"] }
        }
      }
    });

    expect(parseMarkdownDocument(file!.path, file!.content, "model").links).toEqual([]);
  });
});
