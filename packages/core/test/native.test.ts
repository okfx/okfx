import { describe, expect, it } from "vitest";

import {
  formatMarkdownFileAccelerated,
  nativeCapabilities,
  parseMarkdownDocumentAccelerated,
  type NativeJsonBinding
} from "../src/index.js";

describe("native wrapper", () => {
  it("falls back to TypeScript implementations when no binding is present", () => {
    const parsed = parseMarkdownDocumentAccelerated(
      "concept.md",
      "---\ntype: Note\n---\n# Concept\n",
      "concept",
      { binding: null }
    );
    const formatted = formatMarkdownFileAccelerated(
      "concept.md",
      "---\ntitle: Concept\ntype: Note\n---\n# Concept",
      {},
      { binding: null }
    );

    expect(parsed.body.headings[0]?.title).toBe("Concept");
    expect(formatted.formatted).toContain("type: Note\ntitle: Concept");
  });

  it("uses an injected native JSON binding when available", () => {
    const binding: NativeJsonBinding = {
      nativeCapabilitiesJson: () => JSON.stringify({ crate: "okfx_napi", capabilities: ["parse"] }),
      parseMarkdownDocumentJson: (path: string) => JSON.stringify({
        path,
        body: { raw: "", text: "", headings: [] },
        links: [],
        diagnostics: [],
        contentHash: "native"
      }),
      formatMarkdownDocumentJson: () => JSON.stringify({
        formatted: "native",
        changed: true,
        diagnostics: []
      })
    };

    expect(nativeCapabilities(binding)).toMatchObject({ crate: "okfx_napi" });
    expect(parseMarkdownDocumentAccelerated("native.md", "", "native", { binding }).contentHash).toBe("native");
    expect(formatMarkdownFileAccelerated("native.md", "", {}, { binding }).formatted).toBe("native");
  });
});
