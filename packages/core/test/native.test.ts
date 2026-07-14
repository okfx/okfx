import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  formatMarkdownFileAccelerated,
  formatMarkdownFileAcceleratedAsync,
  contentHash,
  getNativeBackendStatusAsync,
  getNativeBackendStatus,
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
        contentHash: contentHash("")
      }),
      formatMarkdownDocumentJson: () => JSON.stringify({
        formatted: "native",
        changed: true,
        diagnostics: []
      })
    };

    expect(nativeCapabilities(binding)).toMatchObject({ crate: "okfx_napi" });
    expect(parseMarkdownDocumentAccelerated("native.md", "", "native", { binding }).contentHash)
      .toBe(contentHash(""));
    expect(formatMarkdownFileAccelerated("native.md", "", {}, { binding }).formatted).toBe("native");
  });

  it("ignores binding functions inherited through the prototype chain", () => {
    const binding = Object.create({
      parseMarkdownDocumentJson: () => {
        throw new Error("inherited binding function was called");
      }
    }) as NativeJsonBinding;

    const parsed = parseMarkdownDocumentAccelerated(
      "fallback.md",
      "# Fallback\n",
      "fallback",
      { binding }
    );

    expect(parsed.body.headings[0]?.title).toBe("Fallback");
  });

  it("does not access inherited default exports while loading bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-native-module-"));
    const modulePath = join(root, "binding.cjs");
    const previousBinding = process.env.OKFX_NATIVE_BINDING;
    try {
      await writeFile(modulePath, `
const prototype = {};
Object.defineProperty(prototype, "default", {
  get() {
    throw new Error("inherited default export was accessed");
  }
});
const binding = Object.create(prototype);
binding.nativeCapabilitiesJson = () => "{}";
module.exports = binding;
`, "utf8");
      process.env.OKFX_NATIVE_BINDING = modulePath;

      expect(getNativeBackendStatus().native).toMatchObject({
        available: true,
        source: modulePath
      });
    } finally {
      if (previousBinding === undefined) {
        delete process.env.OKFX_NATIVE_BINDING;
      } else {
        process.env.OKFX_NATIVE_BINDING = previousBinding;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports WASM-style async bindings and normalizes Rust JSON field names", async () => {
    const content = "---\ntype: Note\n---\n# WASM\n[Other](other.md)\n";
    const binding: NativeJsonBinding = {
      wasm_capabilities_json: () => JSON.stringify({ crate: "okfx_wasm", capabilities: ["parse", "format"] }),
      parse_markdown_document_json: () => JSON.stringify({
        path: "wasm.md",
        frontmatter: { type: "Note" },
        frontmatter_raw: "type: Note\n",
        body: {
          raw: "# WASM\n[Other](other.md)\n",
          text: "WASM",
          headings: [{
            level: 1,
            title: "WASM",
            slug: "wasm",
            location: { start: { line: 4, column: 1, offset: 19 }, end: null }
          }]
        },
        links: [{
          source_concept_id: "wasm",
          target_raw: "other.md",
          text: "Other",
          kind: "internal",
          resolved: false,
          location: { start: { line: 5, column: 1, offset: 26 }, end: null }
        }],
        diagnostics: [],
        content_hash: contentHash(content)
      }),
      format_markdown_document_json: () => JSON.stringify({
        formatted: "wasm",
        changed: true,
        diagnostics: []
      })
    };

    const parsed = await parseMarkdownDocumentAcceleratedAsync("wasm.md", content, "wasm", { binding });
    const formatted = await formatMarkdownFileAcceleratedAsync("wasm.md", "", {}, { binding });

    expect(await nativeCapabilitiesAsync(binding)).toMatchObject({ crate: "okfx_wasm" });
    expect(parsed).toMatchObject({
      frontmatterRaw: "type: Note\n",
      contentHash: contentHash(content),
      links: [{ sourceConceptId: "wasm", targetRaw: "other.md" }]
    });
    expect(formatted.formatted).toBe("wasm");
  });

  it("rejects malformed or inconsistent format results from bindings", () => {
    expect(() => formatMarkdownFileAccelerated("native.md", "original", {}, {
      binding: {
        formatMarkdownDocumentJson: () => JSON.stringify({
          formatted: 42,
          changed: true,
          diagnostics: []
        })
      }
    })).toThrow("format result.formatted");

    expect(() => formatMarkdownFileAccelerated("native.md", "original", {}, {
      binding: {
        formatMarkdownDocumentJson: () => JSON.stringify({
          formatted: "changed",
          changed: false,
          diagnostics: []
        })
      }
    })).toThrow("inconsistent format result.changed");

    expect(() => formatMarkdownFileAccelerated("native.md", "original", {}, {
      binding: {
        formatMarkdownDocumentJson: () => JSON.stringify({
          formatted: "original",
          changed: false,
          diagnostics: [{ code: "fmt/test", message: "Bad", severity: "fatal" }]
        })
      }
    })).toThrow("Unsupported format diagnostic severity");
  });

  it("rejects inconsistent parsed document identities, hashes, and locations", () => {
    const parsedDocument = (overrides: Record<string, unknown> = {}) => ({
      path: "native.md",
      body: { raw: "input", text: "input", headings: [] },
      links: [],
      diagnostics: [],
      contentHash: contentHash("input"),
      ...overrides
    });
    const parseWith = (document: unknown) => parseMarkdownDocumentAccelerated(
      "native.md",
      "input",
      "native",
      { binding: { parseMarkdownDocumentJson: () => JSON.stringify(document) } }
    );

    expect(() => parseWith(parsedDocument({ path: "other.md" }))).toThrow("parsed document path");
    expect(() => parseWith(parsedDocument({ contentHash: contentHash("other") })))
      .toThrow("content hash");
    expect(() => parseWith(parsedDocument({
      body: { raw: "other", text: "other", headings: [] }
    }))).toThrow("body.raw");
    expect(() => parseWith(parsedDocument({
      links: [{
        sourceConceptId: "other",
        targetRaw: "target.md",
        kind: "internal",
        resolved: false,
        location: { start: { line: 1, column: 1 } }
      }]
    }))).toThrow("link source concept ID");
    expect(() => parseWith(parsedDocument({
      body: {
        raw: "input",
        text: "",
        headings: [{
          level: 7,
          title: "Bad",
          slug: "bad",
          location: { start: { line: 0, column: 1.5, offset: -1 } }
        }]
      }
    }))).toThrow("heading level");
    expect(() => parseWith(parsedDocument({
      body: {
        raw: "input",
        text: "",
        headings: [{
          level: 1,
          title: "Bad",
          slug: "bad",
          location: { start: { line: 0, column: 1 } }
        }]
      }
    }))).toThrow("source line");
    expect(() => parseWith(parsedDocument({
      body: {
        raw: "input",
        text: "",
        headings: [{
          level: 1,
          title: "Bad",
          slug: "bad",
          location: { start: { line: 2, column: 1, offset: 0 } }
        }]
      }
    }))).toThrow("outside the input");
    expect(() => parseWith(parsedDocument({
      body: {
        raw: "input",
        text: "",
        headings: [{
          level: 1,
          title: "Bad",
          slug: "bad",
          location: { start: { line: 1, column: 2, offset: 0 } }
        }]
      }
    }))).toThrow("offset inconsistent");
    expect(() => parseWith(parsedDocument({
      body: {
        raw: "input",
        text: "",
        headings: [{
          level: 1,
          title: "Bad",
          slug: "bad",
          location: {
            start: { line: 1, column: 2, offset: 1 },
            end: { line: 1, column: 1, offset: 0 }
          }
        }]
      }
    }))).toThrow("end precedes");
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
