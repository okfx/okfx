import { describe, expect, it } from "vitest";

import { markdownTargetAt } from "../src/markdown-target.js";

describe("markdownTargetAt", () => {
  it("returns balanced destinations without optional titles", () => {
    const line = "See [Wiki](docs/foo_(bar).md \"Reference\") today";

    expect(markdownTargetAt(line, line.indexOf("bar"))).toBe("docs/foo_(bar).md");
    expect(markdownTargetAt(line, line.indexOf("today"))).toBeUndefined();
  });

  it("honors escaped parentheses", () => {
    const line = "[Escaped](docs/foo_\\(bar\\).md)";

    expect(markdownTargetAt(line, line.indexOf("bar"))).toBe("docs/foo_\\(bar\\).md");
  });

  it("selects the link containing the cursor", () => {
    const line = "[First](first.md) and [Second](second.md)";

    expect(markdownTargetAt(line, line.indexOf("second.md") + 2)).toBe("second.md");
    expect(markdownTargetAt(line, line.indexOf(" and ") + 2)).toBeUndefined();
  });

  it("returns empty and angle-enclosed destinations", () => {
    const enclosed = "[Angle](<docs/a b.md> (Reference))";

    expect(markdownTargetAt(enclosed, enclosed.indexOf("a b"))).toBe("docs/a b.md");
    expect(markdownTargetAt("[Empty]()", 8)).toBe("");
  });

  it("requires whitespace before an enclosed destination title", () => {
    const invalid = "[Invalid](<docs/invalid.md>\"Title\")";
    const valid = "[Valid](<docs/valid.md> \"Title\")";

    expect(markdownTargetAt(invalid, invalid.indexOf("invalid.md"))).toBeUndefined();
    expect(markdownTargetAt(valid, valid.indexOf("valid.md"))).toBe("docs/valid.md");
  });

  it("allows spaces around destinations and titles", () => {
    const bare = "[Bare](   docs/bare.md  )";
    const enclosed = "[Angle](  <docs/a b.md> \"Title\"  )";

    expect(markdownTargetAt(bare, bare.indexOf("bare.md"))).toBe("docs/bare.md");
    expect(markdownTargetAt(enclosed, enclosed.indexOf("a b"))).toBe("docs/a b.md");
  });
});
