import { describe, expect, it } from "vitest";

import { parseMarkdownDocument } from "@okfxjs/core";

import { produceOpenApiOkf } from "../src/index.js";

describe("@okfxjs/adapter-openapi", () => {
  it("produces API concepts", () => {
    const files = produceOpenApiOkf(
      { paths: { "/orders": { get: { summary: "List Orders" } } } },
      { now: new Date("2024-03-02T01:02:03Z") }
    );
    expect(files[0]).toMatchObject({ path: "apis/get-orders.md" });
    expect(files[0]?.content).toContain("type: API");
    expect(files[0]?.content).toContain("timestamp: 2024-03-02T01:02:03.000Z");
  });

  it("ignores inherited document and operation fields", () => {
    const inheritedDocument = Object.create({
      paths: { "/inherited": { get: { summary: "Inherited" } } }
    });
    const operation = Object.create({ summary: "Inherited summary" });

    expect(produceOpenApiOkf(inheritedDocument)).toEqual([]);
    const [file] = produceOpenApiOkf({ paths: { "/orders": { get: operation } } });
    expect(file?.content).toContain('title: "GET /orders"');
    expect(file?.content).not.toContain("Inherited summary");
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

  it("rejects non-string info metadata", () => {
    expect(() => produceOpenApiOkf({
      info: { description: { injected: true } as never },
      paths: { "/orders": { get: {} } }
    })).toThrow("OpenAPI info field description must be a string");
  });

  it("disambiguates operations that reuse an operation id", () => {
    const files = produceOpenApiOkf({
      paths: {
        "/orders": { get: { operationId: "list" } },
        "/customers": { get: { operationId: "list" } }
      }
    });

    expect(new Set(files.map((file) => file.path))).toHaveLength(2);
    expect(files.every((file) => file.path.startsWith("apis/list-"))).toBe(true);
  });

  it("does not turn imported operation metadata into Markdown links", () => {
    const [file] = produceOpenApiOkf({
      paths: {
        "/orders` [Route](evil.md)": {
          get: { summary: "[Orders](other.md)" }
        }
      }
    });

    expect(parseMarkdownDocument(file!.path, file!.content, "operation").links).toEqual([]);
  });

  it("uses a safe fallback path for Unicode-only operation ids", () => {
    const [file] = produceOpenApiOkf({
      paths: { "/orders": { get: { operationId: "\u83b7\u53d6\u8ba2\u5355" } } }
    });

    expect(file?.path).toBe("apis/operation.md");
  });
});
