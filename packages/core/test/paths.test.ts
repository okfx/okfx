import { describe, expect, it } from "vitest";

import { relativeMarkdownTarget, resolveMarkdownTarget } from "../src/index.js";

describe("relativeMarkdownTarget", () => {
  it("builds links relative to the source document directory", () => {
    expect(relativeMarkdownTarget("domains/orders/api.md", "domains/orders/runbook.md"))
      .toBe("runbook.md");
    expect(relativeMarkdownTarget("domains/orders/api.md", "shared/auth.md"))
      .toBe("../../shared/auth.md");
    expect(relativeMarkdownTarget("indexing.md", "shared/auth.md"))
      .toBe("shared/auth.md");
  });

  it("round-trips through Markdown target resolution", () => {
    const source = "domains/orders/api.md";
    const target = "shared/auth.md";

    expect(resolveMarkdownTarget(source, relativeMarkdownTarget(source, target)))
      .toBe("shared/auth");
  });
});
