import { describe, expect, it } from "vitest";

import {
  disambiguateGeneratedPaths,
  escapeMarkdownText,
  generationTimestamp,
  markdownCodeSpan
} from "../src/index.js";

describe("generationTimestamp", () => {
  it("serializes an injected generation time", () => {
    expect(generationTimestamp(new Date("2024-03-02T01:02:03Z")))
      .toBe("2024-03-02T01:02:03.000Z");
  });

  it("rejects invalid dates", () => {
    expect(() => generationTimestamp(new Date(Number.NaN)))
      .toThrow("Generation time must be a valid Date");
  });
});

describe("disambiguateGeneratedPaths", () => {
  it("preserves unique paths and deterministically disambiguates collisions", () => {
    const input = [
      { path: "tables/orders.md", identity: "project-a.orders", content: "A" },
      { path: "tables/orders.md", identity: "project-b.orders", content: "B" },
      { path: "tables/customers.md", identity: "project-a.customers", content: "C" }
    ];
    const forward = disambiguateGeneratedPaths(input);
    const reversed = disambiguateGeneratedPaths([...input].reverse());

    expect(forward.find((file) => file.content === "C")?.path).toBe("tables/customers.md");
    expect(new Set(forward.map((file) => file.path))).toHaveLength(3);
    expect(Object.fromEntries(forward.map((file) => [file.content, file.path])))
      .toEqual(Object.fromEntries(reversed.map((file) => [file.content, file.path])));
  });

  it("disambiguates paths that collide after portable normalization", () => {
    const files = disambiguateGeneratedPaths([
      { path: "Notes/Caf\u00e9.md", identity: "composed", content: "A" },
      { path: "notes/cafe\u0301.md", identity: "decomposed", content: "B" }
    ]);

    expect(new Set(files.map((file) => file.path.normalize("NFC").toLowerCase())))
      .toHaveLength(2);
    expect(files.every((file) => /-[a-z0-9]{7}\.md$/u.test(file.path))).toBe(true);
  });

  it("rejects duplicate identities at the same output path", () => {
    expect(() => disambiguateGeneratedPaths([
      { path: "tables/orders.md", identity: "project.orders", content: "A" },
      { path: "tables/orders.md", identity: "project.orders", content: "B" }
    ])).toThrow("duplicate identity");
  });
});

describe("Markdown generation helpers", () => {
  it("escapes structural text and chooses a safe code delimiter", () => {
    expect(escapeMarkdownText("Title\n[Injected](evil.md)"))
      .toBe("Title \\[Injected\\]\\(evil\\.md\\)");
    expect(markdownCodeSpan("name` [Injected](evil.md)"))
      .toBe("`` name` [Injected](evil.md) ``");
  });
});
