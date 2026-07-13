import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { resolveConfig, type OkfxConfig, type ResolvedOkfxConfig } from "./config.js";
import { formatMarkdownFile } from "./format.js";
import { parseMarkdownDocument, type ParsedMarkdownDocument } from "./parser.js";
import type { DiagnosticIR, HeadingIR, LinkIR, LinkKind, SourceLocationIR, SourceRangeIR } from "./types.js";

export type NativeBackendKind = "native" | "wasm";
export type NativeLibc = "gnu" | "musl";

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

export interface NativePlatformPackage {
  packageName: string;
  os: NodeJS.Platform;
  arch: NodeJS.Architecture;
  libc?: NativeLibc;
  binary: string;
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

export const NATIVE_PLATFORM_PACKAGES: readonly NativePlatformPackage[] = [
  {
    packageName: "@okfx/core-darwin-arm64",
    os: "darwin",
    arch: "arm64",
    binary: "okfx_napi.node"
  },
  {
    packageName: "@okfx/core-darwin-x64",
    os: "darwin",
    arch: "x64",
    binary: "okfx_napi.node"
  },
  {
    packageName: "@okfx/core-linux-x64-gnu",
    os: "linux",
    arch: "x64",
    libc: "gnu",
    binary: "okfx_napi.node"
  },
  {
    packageName: "@okfx/core-linux-x64-musl",
    os: "linux",
    arch: "x64",
    libc: "musl",
    binary: "okfx_napi.node"
  },
  {
    packageName: "@okfx/core-win32-x64-msvc",
    os: "win32",
    arch: "x64",
    binary: "okfx_napi.node"
  }
];

export function getNativeBackendStatus(): NativeBackendStatus {
  return {
    native: statusFromAttempt("native", tryLoadNativeBinding()),
    wasm: probeWasmBindingResolution()
  };
}

export async function getNativeBackendStatusAsync(): Promise<NativeBackendStatus> {
  return {
    native: statusFromAttempt("native", tryLoadNativeBinding()),
    wasm: statusFromAttempt("wasm", await tryLoadWasmBinding())
  };
}

export function loadOptionalNativeBinding(): NativeJsonBinding | undefined {
  return tryLoadNativeBinding().binding;
}

export async function loadOptionalWasmBinding(): Promise<NativeJsonBinding | undefined> {
  return (await tryLoadWasmBinding()).binding;
}

export async function loadOptionalBackendBinding(): Promise<NativeJsonBinding | undefined> {
  return loadOptionalNativeBinding() ?? await loadOptionalWasmBinding();
}

export function nativeCapabilities(binding?: NativeJsonBinding | null): unknown {
  const resolvedBinding = binding === undefined ? loadOptionalNativeBinding() : binding ?? undefined;
  if (!resolvedBinding) {
    return {
      crate: "typescript",
      interface: "fallback",
      capabilities: []
    };
  }

  const readCapabilities = bindingFunction(resolvedBinding, [
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

export async function nativeCapabilitiesAsync(
  binding: NativeJsonBinding | null | undefined = undefined
): Promise<unknown> {
  const resolvedBinding = binding === undefined ? await loadOptionalBackendBinding() : binding ?? undefined;
  return nativeCapabilities(resolvedBinding ?? null);
}

export function nativePlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  libc: NativeLibc | undefined = detectLinuxLibc(platform)
): string | undefined {
  return NATIVE_PLATFORM_PACKAGES.find((target) => {
    if (target.os !== platform || target.arch !== arch) {
      return false;
    }
    return target.libc === undefined || target.libc === libc;
  })?.packageName;
}

export function nativeBindingPackageNames(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  libc: NativeLibc | undefined = detectLinuxLibc(platform)
): string[] {
  const platformPackage = nativePlatformPackageName(platform, arch, libc);
  return [
    ...(platformPackage ? [platformPackage] : []),
    "@okfx/native"
  ];
}

export function wasmBindingPackageNames(): string[] {
  return [
    "@okfx/wasm",
    "@okfx/core-wasm"
  ];
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

  return normalizeParsedDocument(parseJson(parseNative(path, content, sourceConceptId)), path, sourceConceptId);
}

export async function parseMarkdownDocumentAcceleratedAsync(
  path: string,
  content: string,
  sourceConceptId: string,
  options: NativeCallOptions = {}
): Promise<ParsedMarkdownDocument> {
  const binding = options.binding === undefined ? await loadOptionalBackendBinding() : options.binding ?? undefined;
  return parseMarkdownDocumentAccelerated(path, content, sourceConceptId, { binding: binding ?? null });
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

export async function formatMarkdownFileAcceleratedAsync(
  path: string,
  content: string,
  config: OkfxConfig | ResolvedOkfxConfig = {},
  options: NativeCallOptions = {}
): Promise<FormatAcceleratedResult> {
  const binding = options.binding === undefined ? await loadOptionalBackendBinding() : options.binding ?? undefined;
  return formatMarkdownFileAccelerated(path, content, config, { binding: binding ?? null });
}

interface BindingLoadAttempt {
  binding?: NativeJsonBinding;
  source?: string;
  errors: string[];
}

function tryLoadNativeBinding(): BindingLoadAttempt {
  const errors: string[] = [];
  for (const candidate of nativeBindingCandidates()) {
    try {
      if (candidate.path && !existsSync(candidate.path)) {
        errors.push(`${candidate.specifier}: missing`);
        continue;
      }
      return {
        binding: normalizeBindingModule(requireFromHere(candidate.specifier)),
        source: candidate.specifier,
        errors
      };
    } catch (error) {
      errors.push(`${candidate.specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { errors };
}

async function tryLoadWasmBinding(): Promise<BindingLoadAttempt> {
  const errors: string[] = [];
  for (const candidate of wasmBindingCandidates()) {
    try {
      if (candidate.path && !existsSync(candidate.path)) {
        errors.push(`${candidate.specifier}: missing`);
        continue;
      }
      const imported = await import(candidate.specifier) as unknown;
      const importedRecord = isRecord(imported) ? imported : {};
      const initialized = typeof importedRecord.default === "function"
        ? await importedRecord.default()
        : undefined;
      return {
        binding: normalizeBindingModule(importedRecord, initialized),
        source: candidate.specifier,
        errors
      };
    } catch (error) {
      errors.push(`${candidate.specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { errors };
}

function statusFromAttempt(kind: NativeBackendKind, attempt: BindingLoadAttempt): NativeBindingStatus {
  if (attempt.binding && attempt.source) {
    return {
      kind,
      available: true,
      source: attempt.source
    };
  }

  return {
    kind,
    available: false,
    error: attempt.errors.join("; ")
  };
}

function probeWasmBindingResolution(): NativeBindingStatus {
  const errors: string[] = [];
  for (const candidate of wasmBindingCandidates()) {
    try {
      if (candidate.path) {
        if (!existsSync(candidate.path)) {
          errors.push(`${candidate.specifier}: missing`);
          continue;
        }
      } else {
        requireFromHere.resolve(candidate.specifier);
      }
      return {
        kind: "wasm",
        available: true,
        source: candidate.specifier
      };
    } catch (error) {
      errors.push(`${candidate.specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    kind: "wasm",
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
    ...nativeBindingPackageNames().map((specifier) => ({ specifier })),
    localCandidate("../native/okfx_napi.node")
  ];
}

function wasmBindingCandidates(): BindingCandidate[] {
  const envPath = process.env.OKFX_WASM_BINDING;
  return [
    ...(envPath ? [{ specifier: envPath, path: envPath }] : []),
    ...wasmBindingPackageNames().map((specifier) => ({ specifier })),
    localCandidate("../wasm/okfx_wasm.js")
  ];
}

function detectLinuxLibc(platform: NodeJS.Platform = process.platform): NativeLibc | undefined {
  if (platform !== "linux") {
    return undefined;
  }

  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
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

function normalizeBindingModule(module: unknown, initialized?: unknown): NativeJsonBinding {
  const binding: NativeJsonBinding = {};
  if (isRecord(module) && isRecord(module.default)) {
    Object.assign(binding, module.default);
  }
  if (isRecord(module)) {
    Object.assign(binding, module);
  }
  if (isRecord(initialized)) {
    Object.assign(binding, initialized);
  }

  const supportedFunctions = [
    "nativeCapabilitiesJson",
    "native_capabilities_json",
    "wasmCapabilitiesJson",
    "wasm_capabilities_json",
    "parseMarkdownDocumentJson",
    "parse_markdown_document_json",
    "formatMarkdownDocumentJson",
    "format_markdown_document_json"
  ];
  if (!supportedFunctions.some((name) => typeof binding[name] === "function")) {
    throw new TypeError("Binding module does not expose a supported okfx JSON function.");
  }
  return binding;
}

function normalizeParsedDocument(value: unknown, fallbackPath: string, fallbackSourceConceptId: string): ParsedMarkdownDocument {
  const document = requiredRecord(value, "parsed document");
  const body = requiredRecord(document.body, "parsed document body");
  const headings = requiredArray(body.headings, "parsed document headings").map(normalizeHeading);
  const links = requiredArray(document.links, "parsed document links").map((link) => normalizeLink(link, fallbackSourceConceptId));
  const diagnostics = requiredArray(document.diagnostics, "parsed document diagnostics").map(normalizeDiagnostic);
  const frontmatter = document.frontmatter === null || document.frontmatter === undefined
    ? undefined
    : requiredRecord(document.frontmatter, "parsed document frontmatter");

  return {
    path: optionalString(document.path) ?? fallbackPath,
    frontmatter,
    frontmatterRaw: optionalString(field(document, "frontmatterRaw", "frontmatter_raw")),
    body: {
      raw: requiredString(body.raw, "parsed document body.raw"),
      text: requiredString(body.text, "parsed document body.text"),
      headings
    },
    links,
    diagnostics,
    contentHash: requiredString(field(document, "contentHash", "content_hash"), "parsed document content hash")
  };
}

function normalizeHeading(value: unknown): HeadingIR {
  const heading = requiredRecord(value, "heading");
  return {
    level: requiredNumber(heading.level, "heading level"),
    title: requiredString(heading.title, "heading title"),
    slug: requiredString(heading.slug, "heading slug"),
    location: normalizeRange(heading.location)
  };
}

function normalizeLink(value: unknown, fallbackSourceConceptId: string): LinkIR {
  const link = requiredRecord(value, "link");
  const kind = requiredString(link.kind, "link kind");
  if (!isLinkKind(kind)) {
    throw new TypeError(`Unsupported link kind from binding: ${kind}`);
  }
  return {
    sourceConceptId: optionalString(field(link, "sourceConceptId", "source_concept_id")) ?? fallbackSourceConceptId,
    targetRaw: requiredString(field(link, "targetRaw", "target_raw"), "link target"),
    targetConceptId: optionalString(field(link, "targetConceptId", "target_concept_id")),
    text: optionalString(link.text),
    kind,
    resolved: typeof link.resolved === "boolean" ? link.resolved : false,
    location: normalizeRange(link.location)
  };
}

function normalizeDiagnostic(value: unknown): DiagnosticIR {
  const diagnostic = requiredRecord(value, "diagnostic");
  const severity = requiredString(diagnostic.severity, "diagnostic severity");
  if (severity !== "error" && severity !== "warning" && severity !== "advice" && severity !== "info") {
    throw new TypeError(`Unsupported diagnostic severity from binding: ${severity}`);
  }
  return {
    code: requiredString(diagnostic.code, "diagnostic code"),
    severity,
    message: requiredString(diagnostic.message, "diagnostic message"),
    path: optionalString(diagnostic.path),
    conceptId: optionalString(field(diagnostic, "conceptId", "concept_id")),
    location: diagnostic.location === null || diagnostic.location === undefined
      ? undefined
      : normalizeRange(diagnostic.location)
  };
}

function normalizeRange(value: unknown): SourceRangeIR {
  const range = requiredRecord(value, "source range");
  return {
    start: normalizeLocation(range.start),
    end: range.end === null || range.end === undefined ? undefined : normalizeLocation(range.end)
  };
}

function normalizeLocation(value: unknown): SourceLocationIR {
  const location = requiredRecord(value, "source location");
  return {
    line: requiredNumber(location.line, "source line"),
    column: requiredNumber(location.column, "source column"),
    offset: typeof location.offset === "number" ? location.offset : undefined
  };
}

function field(record: Record<string, unknown>, camelCase: string, snakeCase: string): unknown {
  return record[camelCase] ?? record[snakeCase];
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`Binding returned invalid ${label}; expected an object.`);
  }
  return value;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Binding returned invalid ${label}; expected an array.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Binding returned invalid ${label}; expected a string.`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Binding returned invalid ${label}; expected a finite number.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isLinkKind(value: string): value is LinkKind {
  return value === "internal" || value === "external" || value === "anchor" || value === "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson<T = unknown>(value: string): T {
  return JSON.parse(value) as T;
}
