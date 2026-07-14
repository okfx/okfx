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
});
