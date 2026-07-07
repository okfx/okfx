import { describe, expect, it } from "vitest";

import {
  formatMarkdownFileAccelerated,
  nativeCapabilities,
  nativeBindingPackageNames,
  nativePlatformPackageName,
  parseMarkdownDocumentAccelerated,
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
