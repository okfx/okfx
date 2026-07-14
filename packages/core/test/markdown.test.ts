import { describe, expect, it } from "vitest";

import { parseMarkdownDocument } from "../src/index.js";

describe("Markdown code fences", () => {
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
});
