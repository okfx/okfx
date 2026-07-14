import { describe, expect, it } from "vitest";

import { parseMarkdownDocument } from "@okfx/core";

import { produceMarkdownOkf } from "../src/index.js";

describe("@okfx/adapter-markdown", () => {
  it("produces OKF notes", () => {
    const files = produceMarkdownOkf(
      [{ path: "notes/demo", body: "# Demo\n" }],
      { now: new Date("2024-03-02T01:02:03Z") }
    );
    expect(files[0]).toMatchObject({ path: "notes/demo.md" });
    expect(files[0]?.content).toContain("type: Note");
    expect(files[0]?.content).toContain("timestamp: 2024-03-02T01:02:03.000Z");
  });

  it("requires own source fields and ignores inherited optional metadata", () => {
    const inheritedSource = Object.create({ path: "note", body: "# Note\n" });
    const source = Object.assign(
      Object.create({ title: "Inherited", tags: ["inherited"] }),
      { path: "notes/own", body: "# Own\n" }
    );

    expect(() => produceMarkdownOkf([inheritedSource])).toThrow("must include string path and body");
    const [file] = produceMarkdownOkf([source]);
    expect(file?.content).toContain('title: "Own"');
    expect(file?.content).toContain('  - "imported"');
  });

  it("rejects paths outside the output root", () => {
    expect(() => produceMarkdownOkf([{ path: "../../escaped", body: "# Escaped\n" }]))
      .toThrow("escapes the output root");
  });

  it.each([".", "foo/..", "foo/"])("rejects non-file path %j", (path) => {
    expect(() => produceMarkdownOkf([{ path, body: "# Invalid\n" }]))
      .toThrow("must identify a file");
  });

  it.each([".md", "notes/.md", "..md", "...md"])("rejects path %j without a usable concept ID", (path) => {
    expect(() => produceMarkdownOkf([{ path, body: "# Invalid\n" }]))
      .toThrow("must identify a concept");
  });

  it("rejects whitespace-only paths", () => {
    expect(() => produceMarkdownOkf([{ path: "   ", body: "# Invalid\n" }]))
      .toThrow("must be a non-empty relative path");
  });

  it("quotes frontmatter values from imported metadata", () => {
    const [file] = produceMarkdownOkf([{
      path: "notes/safe",
      title: "Safe\nresource: https://attacker.invalid",
      tags: ["safe\nowner: attacker"],
      body: "# Safe\n"
    }]);

    expect(file?.content).toContain('title: "Safe\\nresource: https://attacker.invalid"');
    expect(file?.content).toContain('  - "safe\\nowner: attacker"');
    expect(file?.content).not.toContain("\nresource: https://attacker.invalid\n");
  });

  it("serializes empty tag arrays as YAML arrays", () => {
    const [file] = produceMarkdownOkf([{ path: "notes/empty", body: "# Empty\n", tags: [] }]);
    const parsed = parseMarkdownDocument(file!.path, file!.content, "notes/empty");

    expect(file?.content).toContain("tags: []");
    expect(parsed.frontmatter.tags).toEqual([]);
    expect(parsed.diagnostics).toEqual([]);
  });

  it.each([
    ["notes/my-concept.md", "My Concept"],
    ["notes\\my.concept.md", "My Concept"]
  ])("derives a title from the source filename %j", (path, title) => {
    const [file] = produceMarkdownOkf([{ path, body: "# Imported\n" }]);

    expect(file?.content).toContain(`title: ${JSON.stringify(title)}`);
  });

  it("validates adapter input at runtime", () => {
    expect(() => produceMarkdownOkf({ path: "note", body: "# Note" } as never))
      .toThrow("must be an array");
  });

  it("rejects sparse tag arrays", () => {
    const tags = new Array<string>(1);

    expect(() => produceMarkdownOkf([{ path: "note", body: "# Note", tags }]))
      .toThrow("tags at index 0 must be an array of strings");
  });

  it("disambiguates source paths that normalize to the same output", () => {
    const files = produceMarkdownOkf([
      { path: "notes/archive/../demo", body: "# Archived\n" },
      { path: "notes/demo", body: "# Current\n" }
    ]);

    expect(new Set(files.map((file) => file.path))).toHaveLength(2);
    expect(files.every((file) => file.path.startsWith("notes/demo-"))).toBe(true);
  });

  it("normalizes source names to portable generated paths", () => {
    const files = produceMarkdownOkf([
      { path: "CON", body: "# Reserved\n" },
      { path: "guides./danger*", body: "# Invalid characters\n" },
      { path: "...", body: "# Dots\n" }
    ]);

    expect(files.map((file) => file.path)).toEqual([
      "_CON.md",
      "guides/danger-.md",
      "concept.md"
    ]);
  });
});
