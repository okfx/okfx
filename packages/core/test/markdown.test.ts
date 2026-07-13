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
});
