import { describe, expect, it } from "vitest";

import {
  formatMarkdownFileAccelerated,
  formatMarkdownFileAcceleratedAsync,
  getNativeBackendStatusAsync,
  nativeCapabilities,
  nativeCapabilitiesAsync,
  nativeBindingPackageNames,
  nativePlatformPackageName,
  parseMarkdownDocumentAccelerated,
  parseMarkdownDocumentAcceleratedAsync,
  wasmBindingPackageNames,
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

  it("supports WASM-style async bindings and normalizes Rust JSON field names", async () => {
    const binding: NativeJsonBinding = {
      wasm_capabilities_json: () => JSON.stringify({ crate: "okfx_wasm", capabilities: ["parse", "format"] }),
      parse_markdown_document_json: () => JSON.stringify({
        path: "wasm.md",
        frontmatter: { type: "Note" },
        frontmatter_raw: "type: Note\n",
        body: {
          raw: "# WASM\n",
          text: "WASM",
          headings: [{
            level: 1,
            title: "WASM",
            slug: "wasm",
            location: { start: { line: 4, column: 1, offset: 20 }, end: null }
          }]
        },
        links: [{
          source_concept_id: "wasm",
          target_raw: "other.md",
          text: "Other",
          kind: "internal",
          resolved: false,
          location: { start: { line: 5, column: 1, offset: 27 }, end: null }
        }],
        diagnostics: [],
        content_hash: "sha256:wasm"
      }),
      format_markdown_document_json: () => JSON.stringify({
        formatted: "wasm",
        changed: true,
        diagnostics: []
      })
    };

    const parsed = await parseMarkdownDocumentAcceleratedAsync("wasm.md", "", "wasm", { binding });
    const formatted = await formatMarkdownFileAcceleratedAsync("wasm.md", "", {}, { binding });

    expect(await nativeCapabilitiesAsync(binding)).toMatchObject({ crate: "okfx_wasm" });
    expect(parsed).toMatchObject({
      frontmatterRaw: "type: Note\n",
      contentHash: "sha256:wasm",
      links: [{ sourceConceptId: "wasm", targetRaw: "other.md" }]
    });
    expect(formatted.formatted).toBe("wasm");
  });

  it("reports asynchronously probed backend status", async () => {
    const status = await getNativeBackendStatusAsync();

    expect(status.native.kind).toBe("native");
    expect(status.wasm.kind).toBe("wasm");
    expect(typeof status.native.available).toBe("boolean");
    expect(typeof status.wasm.available).toBe("boolean");
  });

  it("maps supported platforms to native npm package names", () => {
    expect(nativePlatformPackageName("darwin", "arm64")).toBe("@okfx/core-darwin-arm64");
    expect(nativePlatformPackageName("darwin", "x64")).toBe("@okfx/core-darwin-x64");
    expect(nativePlatformPackageName("linux", "x64", "gnu")).toBe("@okfx/core-linux-x64-gnu");
    expect(nativePlatformPackageName("linux", "x64", "musl")).toBe("@okfx/core-linux-x64-musl");
    expect(nativePlatformPackageName("win32", "x64")).toBe("@okfx/core-win32-x64-msvc");
    expect(nativePlatformPackageName("freebsd", "x64")).toBeUndefined();
  });

  it("keeps portable fallback package candidates after platform-specific packages", () => {
    expect(nativeBindingPackageNames("linux", "x64", "gnu")).toEqual([
      "@okfx/core-linux-x64-gnu",
      "@okfx/native"
    ]);
    expect(nativeBindingPackageNames("linux", "arm64")).toEqual([
      "@okfx/native"
    ]);
    expect(wasmBindingPackageNames()).toEqual([
      "@okfx/wasm",
      "@okfx/core-wasm"
    ]);
  });
});
