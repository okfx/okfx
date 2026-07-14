import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { resolveConfig, type OkfxConfig, type ResolvedOkfxConfig } from "./config.js";
import { formatMarkdownFile } from "./format.js";
import { contentHash } from "./hash.js";
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
    severity: DiagnosticIR["severity"];
    message: string;
    path?: string;
  }>;
}

const requireFromHere = createRequire(import.meta.url);
let nativeAttemptCache: { key: string; attempt: BindingLoadAttempt } | undefined;
let wasmAttemptCache: { key: string; attempt: Promise<BindingLoadAttempt> } | undefined;
const PARSE_BINDING_FUNCTIONS = [
  "parseMarkdownDocumentJson",
  "parse_markdown_document_json"
] as const;
const FORMAT_BINDING_FUNCTIONS = [
  "formatMarkdownDocumentJson",
  "format_markdown_document_json"
] as const;

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
  const parseNative = bindingFunction(binding, PARSE_BINDING_FUNCTIONS);

  if (!parseNative) {
    return parseMarkdownDocument(path, content, sourceConceptId);
  }

  return normalizeParsedDocument(
    parseJson(parseNative(path, content, sourceConceptId)),
    path,
    sourceConceptId,
    content
  );
}

export async function parseMarkdownDocumentAcceleratedAsync(
  path: string,
  content: string,
  sourceConceptId: string,
  options: NativeCallOptions = {}
): Promise<ParsedMarkdownDocument> {
  const binding = options.binding === undefined
    ? await loadOptionalBackendBindingFor(PARSE_BINDING_FUNCTIONS)
    : options.binding ?? undefined;
  return parseMarkdownDocumentAccelerated(path, content, sourceConceptId, { binding: binding ?? null });
}

export function formatMarkdownFileAccelerated(
  path: string,
  content: string,
  config: OkfxConfig | ResolvedOkfxConfig = {},
  options: NativeCallOptions = {}
): FormatAcceleratedResult {
  const binding = options.binding === undefined ? loadOptionalNativeBinding() : options.binding ?? undefined;
  const formatNative = bindingFunction(binding, FORMAT_BINDING_FUNCTIONS);

  if (!formatNative) {
    return formatMarkdownFile(path, content, config);
  }

  const resolved = resolveConfig(config);
  return normalizeFormatResult(
    parseJson(formatNative(path, content, JSON.stringify(resolved.frontmatter.keyOrder))),
    content,
    path
  );
}

export async function formatMarkdownFileAcceleratedAsync(
  path: string,
  content: string,
  config: OkfxConfig | ResolvedOkfxConfig = {},
  options: NativeCallOptions = {}
): Promise<FormatAcceleratedResult> {
  const binding = options.binding === undefined
    ? await loadOptionalBackendBindingFor(FORMAT_BINDING_FUNCTIONS)
    : options.binding ?? undefined;
  return formatMarkdownFileAccelerated(path, content, config, { binding: binding ?? null });
}

async function loadOptionalBackendBindingFor(
  functionNames: readonly string[]
): Promise<NativeJsonBinding | undefined> {
  const native = loadOptionalNativeBinding();
  if (bindingFunction(native, functionNames)) {
    return native;
  }
  const wasm = await loadOptionalWasmBinding();
  return bindingFunction(wasm, functionNames) ? wasm : undefined;
}

interface BindingLoadAttempt {
  binding?: NativeJsonBinding;
  source?: string;
  errors: string[];
}

function tryLoadNativeBinding(): BindingLoadAttempt {
  const key = process.env.OKFX_NATIVE_BINDING ?? "";
  if (nativeAttemptCache?.key === key) {
    return nativeAttemptCache.attempt;
  }

  const attempt = probeNativeBinding();
  nativeAttemptCache = { key, attempt };
  return attempt;
}

function probeNativeBinding(): BindingLoadAttempt {
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

function tryLoadWasmBinding(): Promise<BindingLoadAttempt> {
  const key = process.env.OKFX_WASM_BINDING ?? "";
  if (wasmAttemptCache?.key === key) {
    return wasmAttemptCache.attempt;
  }

  const attempt = probeWasmBinding();
  wasmAttemptCache = { key, attempt };
  return attempt;
}

async function probeWasmBinding(): Promise<BindingLoadAttempt> {
  const errors: string[] = [];
  for (const candidate of wasmBindingCandidates()) {
    try {
      if (candidate.path && !existsSync(candidate.path)) {
        errors.push(`${candidate.specifier}: missing`);
        continue;
      }
      const imported = await import(candidate.specifier) as unknown;
      const importedRecord = isRecord(imported) ? imported : {};
      const defaultExport = Object.hasOwn(importedRecord, "default")
        ? importedRecord.default
        : undefined;
      const initialized = typeof defaultExport === "function"
        ? await defaultExport()
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
  names: readonly string[]
): ((...args: string[]) => string) | undefined {
  for (const name of names) {
    if (!binding || !Object.hasOwn(binding, name)) {
      continue;
    }
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
  const binding = Object.create(null) as NativeJsonBinding;
  const defaultExport = isRecord(module) && Object.hasOwn(module, "default")
    ? module.default
    : undefined;
  if (isRecord(defaultExport)) {
    Object.assign(binding, defaultExport);
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
  if (!supportedFunctions.some(
    (name) => Object.hasOwn(binding, name) && typeof binding[name] === "function"
  )) {
    throw new TypeError("Binding module does not expose a supported okfx JSON function.");
  }
  return binding;
}

function normalizeParsedDocument(
  value: unknown,
  fallbackPath: string,
  fallbackSourceConceptId: string,
  content: string
): ParsedMarkdownDocument {
  const document = requiredRecord(value, "parsed document");
  const returnedPath = optionalStrictString(ownValue(document, "path"), "parsed document path");
  if (returnedPath !== undefined && returnedPath !== fallbackPath) {
    throw new TypeError(`Binding returned parsed document path "${returnedPath}" for "${fallbackPath}".`);
  }
  const body = requiredRecord(ownValue(document, "body"), "parsed document body");
  const bounds = sourceBounds(content);
  const headings = requiredArray(ownValue(body, "headings"), "parsed document headings")
    .map((heading) => normalizeHeading(heading, bounds));
  const links = requiredArray(ownValue(document, "links"), "parsed document links")
    .map((link) => normalizeLink(link, fallbackSourceConceptId, bounds));
  const diagnostics = requiredArray(ownValue(document, "diagnostics"), "parsed document diagnostics")
    .map((diagnostic) => normalizeDiagnostic(diagnostic, fallbackPath, bounds));
  const configuredFrontmatter = ownValue(document, "frontmatter");
  const frontmatter = configuredFrontmatter === null || configuredFrontmatter === undefined
    ? undefined
    : requiredRecord(configuredFrontmatter, "parsed document frontmatter");
  const returnedContentHash = requiredString(
    field(document, "contentHash", "content_hash"),
    "parsed document content hash"
  );
  const frontmatterRaw = optionalStrictString(
    field(document, "frontmatterRaw", "frontmatter_raw"),
    "parsed document frontmatter raw"
  );
  const bodyRaw = requiredString(ownValue(body, "raw"), "parsed document body.raw");
  const expectedContentHash = contentHash(content);
  if (returnedContentHash !== expectedContentHash) {
    throw new TypeError("Binding returned parsed document content hash that does not match the input.");
  }
  assertParsedContentSlices(content, frontmatterRaw, bodyRaw);

  return {
    path: fallbackPath,
    frontmatter,
    frontmatterRaw,
    body: {
      raw: bodyRaw,
      text: requiredString(ownValue(body, "text"), "parsed document body.text"),
      headings
    },
    links,
    diagnostics,
    contentHash: returnedContentHash
  };
}

function assertParsedContentSlices(
  content: string,
  frontmatterRaw: string | undefined,
  bodyRaw: string
): void {
  if (frontmatterRaw === undefined) {
    if (bodyRaw !== content) {
      throw new TypeError("Binding returned parsed document body.raw that does not match the input.");
    }
    return;
  }

  const opening = /^---(?:\r\n|\n|\r)/.exec(content);
  if (!opening) {
    throw new TypeError("Binding returned parsed document frontmatter raw for input without frontmatter.");
  }
  const afterOpening = content.slice(opening[0].length);
  if (!afterOpening.startsWith(frontmatterRaw)) {
    throw new TypeError("Binding returned parsed document frontmatter raw that does not match the input.");
  }
  const afterFrontmatter = afterOpening.slice(frontmatterRaw.length);
  const closing = /^---[ \t]*(?:\r\n|\n|\r|$)/.exec(afterFrontmatter);
  if (!closing || bodyRaw !== afterFrontmatter.slice(closing[0].length)) {
    throw new TypeError("Binding returned parsed document body.raw that does not match the input.");
  }
}

function normalizeFormatResult(
  value: unknown,
  originalContent: string,
  expectedPath: string
): FormatAcceleratedResult {
  const result = requiredRecord(value, "format result");
  const formatted = requiredString(ownValue(result, "formatted"), "format result.formatted");
  const changed = requiredBoolean(ownValue(result, "changed"), "format result.changed");
  if (changed !== (formatted !== originalContent)) {
    throw new TypeError("Binding returned inconsistent format result.changed.");
  }

  return {
    formatted,
    changed,
    diagnostics: requiredArray(ownValue(result, "diagnostics"), "format result diagnostics")
      .map((diagnostic) => normalizeFormatDiagnostic(diagnostic, expectedPath))
  };
}

function normalizeFormatDiagnostic(
  value: unknown,
  expectedPath: string
): FormatAcceleratedResult["diagnostics"][number] {
  const diagnostic = requiredRecord(value, "format diagnostic");
  const severity = requiredString(ownValue(diagnostic, "severity"), "format diagnostic severity");
  if (!isDiagnosticSeverity(severity)) {
    throw new TypeError(`Unsupported format diagnostic severity from binding: ${severity}`);
  }
  const returnedPath = optionalStrictString(ownValue(diagnostic, "path"), "format diagnostic path");
  if (returnedPath !== undefined && returnedPath !== expectedPath) {
    throw new TypeError(`Binding returned format diagnostic path "${returnedPath}" for "${expectedPath}".`);
  }
  return {
    code: requiredString(ownValue(diagnostic, "code"), "format diagnostic code"),
    message: requiredString(ownValue(diagnostic, "message"), "format diagnostic message"),
    path: returnedPath,
    severity
  };
}

function normalizeHeading(value: unknown, bounds: SourceBounds): HeadingIR {
  const heading = requiredRecord(value, "heading");
  return {
    level: requiredInteger(ownValue(heading, "level"), "heading level", 1, 6),
    title: requiredString(ownValue(heading, "title"), "heading title"),
    slug: requiredString(ownValue(heading, "slug"), "heading slug"),
    location: normalizeRange(ownValue(heading, "location"), bounds)
  };
}

function normalizeLink(value: unknown, fallbackSourceConceptId: string, bounds: SourceBounds): LinkIR {
  const link = requiredRecord(value, "link");
  const returnedSourceConceptId = optionalStrictString(
    field(link, "sourceConceptId", "source_concept_id"),
    "link source concept ID"
  );
  if (returnedSourceConceptId !== undefined && returnedSourceConceptId !== fallbackSourceConceptId) {
    throw new TypeError(
      `Binding returned link source concept ID "${returnedSourceConceptId}" for "${fallbackSourceConceptId}".`
    );
  }
  const kind = requiredString(ownValue(link, "kind"), "link kind");
  if (!isLinkKind(kind)) {
    throw new TypeError(`Unsupported link kind from binding: ${kind}`);
  }
  const targetConceptId = optionalStrictString(
    field(link, "targetConceptId", "target_concept_id"),
    "link target concept ID"
  );
  return {
    sourceConceptId: fallbackSourceConceptId,
    targetRaw: requiredString(field(link, "targetRaw", "target_raw"), "link target"),
    ...(targetConceptId === undefined ? {} : { targetConceptId }),
    text: optionalStrictString(ownValue(link, "text"), "link text"),
    kind,
    resolved: requiredBoolean(ownValue(link, "resolved"), "link resolved state"),
    location: normalizeRange(ownValue(link, "location"), bounds)
  };
}

function normalizeDiagnostic(value: unknown, fallbackPath: string, bounds: SourceBounds): DiagnosticIR {
  const diagnostic = requiredRecord(value, "diagnostic");
  const returnedPath = optionalStrictString(ownValue(diagnostic, "path"), "diagnostic path");
  if (returnedPath !== undefined && returnedPath !== fallbackPath) {
    throw new TypeError(`Binding returned diagnostic path "${returnedPath}" for "${fallbackPath}".`);
  }
  const severity = requiredString(ownValue(diagnostic, "severity"), "diagnostic severity");
  if (severity !== "error" && severity !== "warning" && severity !== "advice" && severity !== "info") {
    throw new TypeError(`Unsupported diagnostic severity from binding: ${severity}`);
  }
  const conceptId = optionalStrictString(
    field(diagnostic, "conceptId", "concept_id"),
    "diagnostic concept ID"
  );
  return {
    code: requiredString(ownValue(diagnostic, "code"), "diagnostic code"),
    severity,
    message: requiredString(ownValue(diagnostic, "message"), "diagnostic message"),
    path: returnedPath,
    ...(conceptId === undefined ? {} : { conceptId }),
    location: ownValue(diagnostic, "location") === null || ownValue(diagnostic, "location") === undefined
      ? undefined
      : normalizeRange(ownValue(diagnostic, "location"), bounds)
  };
}

function normalizeRange(value: unknown, bounds: SourceBounds): SourceRangeIR {
  const range = requiredRecord(value, "source range");
  const start = normalizeLocation(ownValue(range, "start"), bounds);
  const configuredEnd = ownValue(range, "end");
  const end = configuredEnd === null || configuredEnd === undefined
    ? undefined
    : normalizeLocation(configuredEnd, bounds);
  if (
    end
    && (
      locationPrecedes(end, start)
      || (end.offset !== undefined && start.offset !== undefined && end.offset < start.offset)
    )
  ) {
    throw new TypeError("Binding returned a source range whose end precedes its start.");
  }
  return { start, end };
}

function normalizeLocation(value: unknown, bounds: SourceBounds): SourceLocationIR {
  const location = requiredRecord(value, "source location");
  const line = requiredInteger(ownValue(location, "line"), "source line", 1);
  const column = requiredInteger(ownValue(location, "column"), "source column", 1);
  const offset = optionalInteger(ownValue(location, "offset"), "source offset", 0);
  const lineBounds = bounds.lines[line - 1];
  if (!lineBounds || column > lineBounds.end - lineBounds.start + 1) {
    throw new TypeError("Binding returned a source location outside the input.");
  }
  if (offset !== undefined && offset !== lineBounds.start + column - 1) {
    throw new TypeError("Binding returned a source offset inconsistent with its line and column.");
  }
  return { line, column, offset };
}

interface SourceBounds {
  lines: Array<{ start: number; end: number }>;
}

function sourceBounds(content: string): SourceBounds {
  const lines: SourceBounds["lines"] = [];
  let lineStart = 0;
  let cursor = 0;
  while (cursor < content.length) {
    if (content[cursor] !== "\r" && content[cursor] !== "\n") {
      cursor += 1;
      continue;
    }
    lines.push({ start: lineStart, end: cursor });
    if (content[cursor] === "\r" && content[cursor + 1] === "\n") {
      cursor += 2;
    } else {
      cursor += 1;
    }
    lineStart = cursor;
  }
  lines.push({ start: lineStart, end: content.length });
  return { lines };
}

function locationPrecedes(left: SourceLocationIR, right: SourceLocationIR): boolean {
  if (left.line !== right.line) {
    return left.line < right.line;
  }
  if (left.column !== right.column) {
    return left.column < right.column;
  }
  return false;
}

function field(record: Record<string, unknown>, camelCase: string, snakeCase: string): unknown {
  return ownValue(record, camelCase) ?? ownValue(record, snakeCase);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
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

function requiredInteger(value: unknown, label: string, minimum: number, maximum?: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || (maximum !== undefined && value > maximum)
  ) {
    const range = maximum === undefined ? `at least ${minimum}` : `between ${minimum} and ${maximum}`;
    throw new TypeError(`Binding returned invalid ${label}; expected a safe integer ${range}.`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string, minimum: number): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredInteger(value, label, minimum);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`Binding returned invalid ${label}; expected a boolean.`);
  }
  return value;
}

function optionalStrictString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredString(value, label);
}

function isLinkKind(value: string): value is LinkKind {
  return value === "internal" || value === "external" || value === "anchor" || value === "unknown";
}

function isDiagnosticSeverity(value: string): value is DiagnosticIR["severity"] {
  return value === "error" || value === "warning" || value === "advice" || value === "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson<T = unknown>(value: string): T {
  return JSON.parse(value) as T;
}
