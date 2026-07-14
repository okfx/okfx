import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  markdownTargetAt,
  markdownTargetAtDocument,
  resolveDefinitionTarget
} from "../src/markdown-target.js";

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

  it("matches the parser's destination nesting limit", () => {
    const accepted = `(${"(".repeat(63)}target${")".repeat(63)})`;
    const rejected = `(${"(".repeat(64)}target${")".repeat(64)})`;
    const acceptedLine = `[Accepted](${accepted})`;
    const rejectedLine = `[Rejected](${rejected})`;

    expect(markdownTargetAt(acceptedLine, acceptedLine.indexOf("target"))).toBe(accepted);
    expect(markdownTargetAt(rejectedLine, rejectedLine.indexOf("target"))).toBeUndefined();
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

  it("ignores destination-like text without a matching link label", () => {
    const line = "Plain text](not-a-link.md) and \\[Escaped](also-not.md)";

    expect(markdownTargetAt(line, line.indexOf("not-a-link"))).toBeUndefined();
    expect(markdownTargetAt(line, line.indexOf("also-not"))).toBeUndefined();
  });

  it("falls back past destination-like text inside a valid target", () => {
    const line = "[Outer](docs/foo](bar).md)";

    expect(markdownTargetAt(line, line.indexOf("bar"))).toBe("docs/foo](bar).md");
    expect(markdownTargetAt(line, line.indexOf(".md"))).toBe("docs/foo](bar).md");
  });

  it("ignores images while recognizing image labels nested inside links", () => {
    const line = "[![Diagram](diagram.png)](guide.md)";

    expect(markdownTargetAt(line, line.indexOf("diagram.png"))).toBeUndefined();
    expect(markdownTargetAt(line, line.indexOf("guide.md"))).toBe("guide.md");
  });

  it("keeps inner links from becoming nested outer links", () => {
    const line = "[Outer [Inner](inner.md)](outer.md)";

    expect(markdownTargetAt(line, line.indexOf("inner.md"))).toBe("inner.md");
    expect(markdownTargetAt(line, line.indexOf("outer.md"))).toBeUndefined();
  });

  it("ignores link syntax inside inline code spans", () => {
    const line = "`[Hidden](hidden.md)` ``[Also hidden](also.md)`` [Visible](visible.md)";

    expect(markdownTargetAt(line, line.indexOf("hidden.md"))).toBeUndefined();
    expect(markdownTargetAt(line, line.indexOf("also.md"))).toBeUndefined();
    expect(markdownTargetAt(line, line.indexOf("visible.md"))).toBe("visible.md");
  });

  it("keeps links after escaped backticks visible", () => {
    const line = "\\`[Visible](visible.md)";

    expect(markdownTargetAt(line, line.indexOf("visible.md"))).toBe("visible.md");
  });

  it("indexes unmatched backtick runs by delimiter length", () => {
    const line = Array.from(
      { length: 1_600 },
      (_, index) => `${"`".repeat(index + 1)}x`
    ).join("");
    const started = performance.now();

    expect(markdownTargetAt(line, line.length)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  }, 5000);

  it("indexes link label brackets for malformed candidate-heavy lines", () => {
    const line = `${"](".repeat(20_000)}x`;
    const started = performance.now();

    expect(markdownTargetAt(line, line.length)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  }, 5000);

  it("reuses bracket matches for deeply nested link labels", () => {
    const depth = 20_000;
    const line = `[${"[".repeat(depth)}x${"]".repeat(depth)}](target.md)`;
    const started = performance.now();

    expect(markdownTargetAt(line, line.indexOf("target"))).toBe("target.md");
    expect(performance.now() - started).toBeLessThan(1000);
  }, 5000);
});

describe("resolveDefinitionTarget", () => {
  it("resolves only internal Markdown targets", () => {
    expect(resolveDefinitionTarget("concepts/current.md", "../target.md")).toBe("target");
    expect(resolveDefinitionTarget("concepts/current.md", "https://example.com"))
      .toBeUndefined();
    expect(resolveDefinitionTarget("concepts/current.md", "#details")).toBeUndefined();
  });
});

describe("markdownTargetAtDocument", () => {
  it("ignores links inside backtick and tilde fenced code", () => {
    const markdown = [
      "[Before](before.md)",
      "```markdown",
      "[Hidden](hidden.md)",
      "```",
      "[After](after.md)",
      "~~~text",
      "[Also hidden](also-hidden.md)"
    ].join("\n");

    expect(markdownTargetAtDocument(markdown, 0, 12)).toBe("before.md");
    expect(markdownTargetAtDocument(markdown, 2, 12)).toBeUndefined();
    expect(markdownTargetAtDocument(markdown, 4, 10)).toBe("after.md");
    expect(markdownTargetAtDocument(markdown, 6, 17)).toBeUndefined();
  });
});
