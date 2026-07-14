import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import { conceptIdFromPath, relativeMarkdownTarget, relativePosixPath, resolveMarkdownTarget } from "../src/index.js";

describe("conceptIdFromPath", () => {
  it("removes the Markdown suffix even when it is the entire filename", () => {
    expect(conceptIdFromPath(".md")).toBe("");
    expect(conceptIdFromPath("concepts/.md")).toBe("concepts/");
    expect(conceptIdFromPath("concepts/.hidden.md")).toBe("concepts/.hidden");
  });
});

describe("relativePosixPath", () => {
  it("rejects literal backslashes in POSIX filenames instead of changing their identity", () => {
    if (sep === "\\") {
      return;
    }

    expect(() => relativePosixPath("/bundle", "/bundle/evil\\name.md"))
      .toThrow("non-portable backslash");
  });
});

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

  it("decodes escaped and percent-encoded Markdown destinations", () => {
    expect(resolveMarkdownTarget("index.md", "docs/foo_\\(bar\\).md"))
      .toBe("docs/foo_(bar)");
    expect(resolveMarkdownTarget("index.md", "docs/hello%20world.md"))
      .toBe("docs/hello world");
    expect(resolveMarkdownTarget("index.md", "docs/topic%23one.md"))
      .toBe("docs/topic#one");
    expect(resolveMarkdownTarget("index.md", String.raw`docs/topic\#one.md`))
      .toBe("docs/topic");
    expect(resolveMarkdownTarget("index.md", String.raw`docs/topic\?draft.md`))
      .toBe("docs/topic");
    expect(resolveMarkdownTarget("index.md", "docs/topic%3Fdraft.md"))
      .toBe("docs/topic?draft");
    expect(resolveMarkdownTarget("index.md", "docs/100%.md"))
      .toBe("docs/100%");
  });

  it("rejects traversal after decoding a Markdown destination", () => {
    expect(resolveMarkdownTarget("concepts/current.md", "%2e%2e/%2e%2e/outside.md"))
      .toBeUndefined();
  });

  it("rejects NUL bytes after decoding a Markdown destination", () => {
    expect(resolveMarkdownTarget("index.md", "docs/%00secret.md")).toBeUndefined();
  });
});
