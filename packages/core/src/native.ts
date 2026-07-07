import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { resolveConfig, type OkfxConfig, type ResolvedOkfxConfig } from "./config.js";
import { formatMarkdownFile } from "./format.js";
import { parseMarkdownDocument, type ParsedMarkdownDocument } from "./parser.js";

export type NativeBackendKind = "native" | "wasm";

export interface NativeBindingStatus {
  kind: NativeBackendKind;
  available: boolean;
  source?: string;
  error?: string;
}

export interface NativeBackendStatus {
  native: NativeBindingStatus;
  wasm: NativeBindingStatus;
}

export interface NativeJsonBinding {
  [name: string]: unknown;
}

export interface NativeCallOptions {
  binding?: NativeJsonBinding | null;
}

export interface FormatAcceleratedResult {
  formatted: string;
  changed: boolean;
  diagnostics: Array<{
    code: string;
    severity?: string;
    message: string;
    path?: string;
  }>;
}

const requireFromHere = createRequire(import.meta.url);

export function getNativeBackendStatus(): NativeBackendStatus {
  return {
    native: probeNativeBinding(),
    wasm: probeWasmBinding()
  };
}

export function loadOptionalNativeBinding(): NativeJsonBinding | undefined {
  const candidates = nativeBindingCandidates();
  for (const candidate of candidates) {
    try {
      if (candidate.path && !existsSync(candidate.path)) {
        continue;
      }
      return requireFromHere(candidate.specifier) as NativeJsonBinding;
    } catch {
      continue;
    }
  }

  return undefined;
}

export async function loadOptionalWasmBinding(): Promise<NativeJsonBinding | undefined> {
  const candidates = wasmBindingCandidates();
  for (const candidate of candidates) {
    try {
      if (candidate.path && !existsSync(candidate.path)) {
        continue;
      }
      return await import(candidate.specifier) as NativeJsonBinding;
    } catch {
      continue;
    }
  }

  return undefined;
}

export function nativeCapabilities(binding = loadOptionalNativeBinding()): unknown {
  if (!binding) {
    return {
      crate: "typescript",
      interface: "fallback",
      capabilities: []
    };
  }

  const readCapabilities = bindingFunction(binding, [
    "nativeCapabilitiesJson",
    "native_capabilities_json",
    "wasmCapabilitiesJson",
    "wasm_capabilities_json"
  ]);
  return readCapabilities ? parseJson(readCapabilities()) : {
    crate: "unknown",
    interface: "json",
    capabilities: []
  };
}

export function parseMarkdownDocumentAccelerated(
  path: string,
  content: string,
  sourceConceptId: string,
  options: NativeCallOptions = {}
): ParsedMarkdownDocument {
  const binding = options.binding === undefined ? loadOptionalNativeBinding() : options.binding ?? undefined;
  const parseNative = bindingFunction(binding, [
    "parseMarkdownDocumentJson",
    "parse_markdown_document_json"
  ]);

  if (!parseNative) {
    return parseMarkdownDocument(path, content, sourceConceptId);
  }

  return parseJson<ParsedMarkdownDocument>(parseNative(path, content, sourceConceptId));
}

export function formatMarkdownFileAccelerated(
  path: string,
  content: string,
  config: OkfxConfig | ResolvedOkfxConfig = {},
  options: NativeCallOptions = {}
): FormatAcceleratedResult {
  const binding = options.binding === undefined ? loadOptionalNativeBinding() : options.binding ?? undefined;
  const formatNative = bindingFunction(binding, [
    "formatMarkdownDocumentJson",
    "format_markdown_document_json"
  ]);

  if (!formatNative) {
    return formatMarkdownFile(path, content, config);
  }

  const resolved = resolveConfig(config);
  return parseJson<FormatAcceleratedResult>(
    formatNative(path, content, JSON.stringify(resolved.frontmatter.keyOrder))
  );
}

function probeNativeBinding(): NativeBindingStatus {
  return probeBinding("native", nativeBindingCandidates(), (candidate) => {
    requireFromHere(candidate.specifier);
  });
}

function probeWasmBinding(): NativeBindingStatus {
  return probeBinding("wasm", wasmBindingCandidates(), (candidate) => {
    requireFromHere(candidate.specifier);
  });
}

function probeBinding(
  kind: NativeBackendKind,
  candidates: BindingCandidate[],
  load: (candidate: BindingCandidate) => void
): NativeBindingStatus {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      if (candidate.path && !existsSync(candidate.path)) {
        errors.push(`${candidate.specifier}: missing`);
        continue;
      }
      load(candidate);
      return {
        kind,
        available: true,
        source: candidate.specifier
      };
    } catch (error) {
      errors.push(`${candidate.specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    kind,
    available: false,
    error: errors.join("; ")
  };
}

interface BindingCandidate {
  specifier: string;
  path?: string;
}

function nativeBindingCandidates(): BindingCandidate[] {
  const envPath = process.env.OKFX_NATIVE_BINDING;
  return [
    ...(envPath ? [{ specifier: envPath, path: envPath }] : []),
    { specifier: "@okfx/native" },
    { specifier: "@okfx/native-darwin-arm64" },
    localCandidate("../native/okfx_napi.node")
  ];
}

function wasmBindingCandidates(): BindingCandidate[] {
  const envPath = process.env.OKFX_WASM_BINDING;
  return [
    ...(envPath ? [{ specifier: envPath, path: envPath }] : []),
    { specifier: "@okfx/wasm" },
    localCandidate("../wasm/okfx_wasm.js")
  ];
}

function localCandidate(relative: string): BindingCandidate {
  const url = new URL(relative, import.meta.url);
  return {
    specifier: fileURLToPath(url),
    path: fileURLToPath(url)
  };
}

function bindingFunction(
  binding: NativeJsonBinding | undefined,
  names: string[]
): ((...args: string[]) => string) | undefined {
  for (const name of names) {
    const value = binding?.[name];
    if (typeof value === "function") {
      return (...args: string[]) => {
        const result = value(...args);
        if (typeof result !== "string") {
          throw new TypeError(`Native binding function ${name} returned ${typeof result}, expected string.`);
        }
        return result;
      };
    }
  }

  return undefined;
}

function parseJson<T = unknown>(value: string): T {
  return JSON.parse(value) as T;
}
