import { describe, expect, it } from "vitest";

import { parseMarkdownDocument } from "../src/index.js";

describe("Markdown code fences", () => {
  it("parses ATX indentation and closing markers without truncating literal hashes", () => {
    const parsed = parseMarkdownDocument("concept.md", [
      "# C#",
      "## Closed ##",
      "###",
      "   #### Indented ####",
      "    # Code block",
      "####### Not a heading",
      ""
    ].join("\n"), "concept");

    expect(parsed.body.headings.map(({ level, title, slug }) => ({ level, title, slug }))).toEqual([
      { level: 1, title: "C#", slug: "c" },
      { level: 2, title: "Closed", slug: "closed" },
      { level: 3, title: "", slug: "" },
      { level: 4, title: "Indented", slug: "indented" }
    ]);
    expect(parsed.body.text).toContain("C# Closed");
    expect(parsed.body.text).toContain("####### Not a heading");
  });

  it("ignores headings and links inside backtick and tilde fences", () => {
    const parsed = parseMarkdownDocument("concept.md", [
      "---",
      "type: Note",
      "---",
      "",
      "# Visible",
      "[Visible link](visible.md)",
      "```markdown",
      "# Hidden backtick heading",
      "[Hidden backtick link](hidden-backtick.md)",
      "```",
      "~~~markdown",
      "## Hidden tilde heading",
      "[Hidden tilde link](hidden-tilde.md)",
      "~~~",
      "## Also visible",
      ""
    ].join("\n"), "concept");

    expect(parsed.body.headings.map((heading) => heading.title)).toEqual(["Visible", "Also visible"]);
    expect(parsed.links.map((link) => link.targetRaw)).toEqual(["visible.md"]);
    expect(parsed.body.text).not.toContain("Hidden");
  });

  it("keeps an unclosed fence masked through the end of the document", () => {
    const parsed = parseMarkdownDocument(
      "concept.md",
      "# Visible\n~~~text\n# Hidden\n[Hidden](hidden.md)\n",
      "concept"
    );

    expect(parsed.body.headings.map((heading) => heading.title)).toEqual(["Visible"]);
    expect(parsed.links).toEqual([]);
  });

  it("ignores links inside inline code spans", () => {
    const parsed = parseMarkdownDocument("concept.md", [
      "# Visible",
      "`[single](hidden-single.md)`",
      "``before",
      "[multiline](hidden-multiline.md)",
      "after``",
      "\\`[literal](visible.md)",
      "[Also visible](also-visible.md)",
      ""
    ].join("\n"), "concept");

    expect(parsed.links.map((link) => link.targetRaw)).toEqual([
      "visible.md",
      "also-visible.md"
    ]);
  });

  it("parses balanced and escaped parentheses in link destinations", () => {
    const parsed = parseMarkdownDocument("concept.md", [
      "[Wiki](https://example.com/Foo_(bar))",
      "[Nested](docs/foo_(bar_(baz)).md \"A title\")",
      "[Escaped](docs/foo_\\(bar\\).md)",
      "[Broken](docs/foo_(bar.md)",
      ""
    ].join("\n"), "concept");

    expect(parsed.links.map((link) => link.targetRaw)).toEqual([
      "https://example.com/Foo_(bar)",
      "docs/foo_(bar_(baz)).md",
      "docs/foo_\\(bar\\).md"
    ]);
    expect(parsed.links[0]?.location.end.offset).toBe(37);
  });

  it("parses nested and empty link labels", () => {
    const parsed = parseMarkdownDocument(
      "concept.md",
      "[See [details]](details.md) [](empty.md) [Escaped \\] label](escaped.md)\n",
      "concept"
    );

    expect(parsed.links.map((link) => ({ target: link.targetRaw, text: link.text }))).toEqual([
      { target: "details.md", text: "See [details]" },
      { target: "empty.md", text: undefined },
      { target: "escaped.md", text: "Escaped \\] label" }
    ]);
    expect(parsed.body.text).toBe("See [details] Escaped \\] label");
  });

  it("keeps inner links from becoming nested outer links", () => {
    const parsed = parseMarkdownDocument(
      "concept.md",
      "[Outer [Inner](inner.md)](outer.md) [Image ![Alt](image.png)](image-outer.md)\n",
      "concept"
    );

    expect(parsed.links.map((link) => link.targetRaw)).toEqual(["inner.md", "image-outer.md"]);
  });

  it("parses empty and enclosed destinations with optional titles", () => {
    const parsed = parseMarkdownDocument(
      "concept.md",
      "[Empty]() [Spaced]( ) [Angle](<docs/a b.md> \"Reference\") [Title](docs/title.md (Reference))\n",
      "concept"
    );

    expect(parsed.links.map((link) => ({ target: link.targetRaw, kind: link.kind }))).toEqual([
      { target: "", kind: "unknown" },
      { target: "", kind: "unknown" },
      { target: "docs/a b.md", kind: "internal" },
      { target: "docs/title.md", kind: "internal" }
    ]);
    expect(parsed.body.text).toBe("Empty Spaced Angle Title");
  });

  it("requires whitespace before an enclosed destination title", () => {
    const parsed = parseMarkdownDocument(
      "concept.md",
      "[Invalid](<docs/invalid.md>\"Title\") [Valid](<docs/valid.md> \"Title\")\n",
      "concept"
    );

    expect(parsed.links.map((link) => link.targetRaw)).toEqual(["docs/valid.md"]);
  });

  it("allows spaces around destinations and titles", () => {
    const parsed = parseMarkdownDocument(
      "concept.md",
      "[Leading](   docs/leading.md) [Angle](  <docs/a b.md> ) [Title]( docs/title.md \"Title\"  )\n",
      "concept"
    );

    expect(parsed.links.map((link) => link.targetRaw)).toEqual([
      "docs/leading.md",
      "docs/a b.md",
      "docs/title.md"
    ]);
  });

  it("classifies links after applying Markdown backslash escapes", () => {
    const parsed = parseMarkdownDocument(
      "concept.md",
      String.raw`[External](https\://example.com) [Anchor](\#details) [Internal](docs/item.md)` + "\n",
      "concept"
    );

    expect(parsed.links.map((link) => link.kind)).toEqual(["external", "anchor", "internal"]);
  });

  it("honors escaped link and image markers", () => {
    const parsed = parseMarkdownDocument("concept.md", [
      "\\[Escaped](hidden.md)",
      "\\\\[Visible](visible.md)",
      "![Image](image.png)",
      "\\![Not an image](visible-after-bang.md)",
      ""
    ].join("\n"), "concept");

    expect(parsed.links.map((link) => link.targetRaw)).toEqual([
      "visible.md",
      "visible-after-bang.md"
    ]);
  });

  it("keeps link labels without leaking destinations into plain text", () => {
    const parsed = parseMarkdownDocument(
      "note.md",
      "[Wiki](docs/foo_(bar).md \"Reference\") ![Diagram](images/diagram_(large).png) `[Code](literal.md)`\n",
      "note"
    );

    expect(parsed.body.text).toBe("Wiki Code");
  });
});
