import { BlockList, isIP } from "node:net";
import { isMap, isScalar, parseDocument } from "yaml";

import { buildStringRanks, compareStrings } from "./compare.js";
import { conceptIdFromPath, normalizeRelativePath } from "./paths.js";
import {
  apiMissingAuthNotesDiagnostics,
  metricMissingSourceDiagnostics,
  missingOwnerDiagnostics,
  missingSummaryDiagnostics,
  missingUsageDiagnostics,
  runbookMissingSymptomsDiagnostics
} from "./agent-rules.js";
import { countDiagnostics, diagnosticsExceedThreshold, sortDiagnostics, type DiagnosticCounts } from "./diagnostics.js";
import { resolveConfig, resolveRuleLevel, type OkfxConfig, type ResolvedOkfxConfig, type RuleLevel } from "./config.js";
import { buildGraph } from "./graph.js";
import type { LoadedOkfxPlugin } from "./plugins.js";
import { parseIsoUtcTimestamp } from "./timestamp.js";
import { validateBundle } from "./validation.js";
import type { BundleIR, ConceptIR, DiagnosticIR, DiagnosticSeverity, LinkIR } from "./types.js";

export interface LintOptions {
  config?: OkfxConfig | ResolvedOkfxConfig;
  plugins?: LoadedOkfxPlugin[];
  pluginDiagnostics?: DiagnosticIR[];
}

export interface LintPluginSummary {
  name: string;
  source: string;
  version?: string;
  ruleCount: number;
}

export interface LintResult {
  ok: boolean;
  diagnostics: DiagnosticIR[];
  counts: DiagnosticCounts;
  failOn: DiagnosticSeverity;
  plugins: LintPluginSummary[];
}

interface RuleContext {
  bundle: BundleIR;
  config: ResolvedOkfxConfig;
  pathsBySourceId: Map<string, string>;
  incomingByConceptId: Map<string, number>;
  outgoingByConceptId: Map<string, number>;
}

type RuleRunner = (context: RuleContext) => DiagnosticIR[];

interface BuiltInRule {
  id: string;
  defaultSeverity: RuleLevel;
  run: RuleRunner;
}

const DEFAULT_HIGH_DEGREE_THRESHOLD = 25;
const PRIVATE_IP_RANGES = createPrivateIpRanges();

export function lintBundle(bundle: BundleIR, options: LintOptions = {}): LintResult {
  const config = resolveConfig(options.config ?? {});
  const context = createRuleContext(bundle, config);
  return createLintResult(config, [
    ...configuredValidationDiagnostics(bundle, config),
    ...builtInLintRules.flatMap((rule) => runRule(rule, context)),
    ...(options.pluginDiagnostics ?? [])
  ], []);
}

export async function lintBundleWithPlugins(bundle: BundleIR, options: LintOptions = {}): Promise<LintResult> {
  const config = resolveConfig(options.config ?? {});
  const context = createRuleContext(bundle, config);
  const pluginDiagnostics = await runPluginRules(options.plugins ?? [], context);
  return createLintResult(config, [
    ...configuredValidationDiagnostics(bundle, config),
    ...builtInLintRules.flatMap((rule) => runRule(rule, context)),
    ...(options.pluginDiagnostics ?? []),
    ...pluginDiagnostics
  ], options.plugins ?? []);
}

function createLintResult(
  config: ResolvedOkfxConfig,
  diagnosticsInput: DiagnosticIR[],
  plugins: LoadedOkfxPlugin[]
): LintResult {
  const diagnostics = sortDiagnostics(diagnosticsInput);
  const counts = countDiagnostics(diagnostics);

  return {
    ok: !diagnosticsExceedThreshold(diagnostics, config.failOn),
    diagnostics,
    counts,
    failOn: config.failOn,
    plugins: plugins.map((plugin) => ({
      name: plugin.name,
      source: plugin.source,
      version: plugin.version,
      ruleCount: Object.keys(plugin.rules).length
    }))
  };
}

const builtInLintRules: BuiltInRule[] = [
  {
    id: "hygiene/missing-title",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => !concept.title?.trim())
      .map((concept) => conceptDiagnostic("hygiene/missing-title", "warning", concept, "Concept should include a title."))
  },
  {
    id: "hygiene/missing-description",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => !concept.description?.trim())
      .map((concept) => conceptDiagnostic("hygiene/missing-description", "warning", concept, "Concept should include a description."))
  },
  {
    id: "hygiene/empty-body",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => concept.body.text.length === 0)
      .map((concept) => conceptDiagnostic("hygiene/empty-body", "warning", concept, "Concept body should not be empty."))
  },
  {
    id: "hygiene/duplicate-title",
    defaultSeverity: "warning",
    run: ({ bundle }) => duplicateConceptValues(
      bundle.concepts,
      (concept) => concept.title?.trim().toLowerCase(),
      "hygiene/duplicate-title",
      "warning",
      "Concept title is duplicated."
    )
  },
  {
    id: "hygiene/duplicate-resource",
    defaultSeverity: "warning",
    run: ({ bundle }) => duplicateConceptValues(
      bundle.concepts,
      (concept) => resourceValues(concept).map((resource) => resource.trim().toLowerCase()),
      "hygiene/duplicate-resource",
      "warning",
      "Concept resource is duplicated."
    )
  },
  {
    id: "graph/broken-internal-link",
    defaultSeverity: "warning",
    run: ({ bundle, pathsBySourceId }) => bundle.links
      .filter((link) => link.kind === "internal" && !link.resolved)
      .map((link) => linkDiagnostic(
        "graph/broken-internal-link",
        "warning",
        link,
        pathsBySourceId,
        `Internal link target "${link.targetRaw}" does not resolve to a concept.`
      ))
  },
  {
    id: "graph/orphan-concept",
    defaultSeverity: "advice",
    run: ({ bundle, incomingByConceptId, outgoingByConceptId }) => bundle.concepts
      .filter((concept) => (incomingByConceptId.get(concept.id) ?? 0) === 0)
      .filter((concept) => (outgoingByConceptId.get(concept.id) ?? 0) === 0)
      .map((concept) => conceptDiagnostic("graph/orphan-concept", "advice", concept, "Concept has no incoming or outgoing concept links."))
  },
  {
    id: "graph/no-backlinks",
    defaultSeverity: "advice",
    run: ({ bundle, incomingByConceptId, outgoingByConceptId }) => bundle.concepts
      .filter((concept) => (incomingByConceptId.get(concept.id) ?? 0) === 0)
      .filter((concept) => (outgoingByConceptId.get(concept.id) ?? 0) > 0)
      .map((concept) => conceptDiagnostic("graph/no-backlinks", "advice", concept, "Concept has no backlinks."))
  },
  {
    id: "graph/high-degree-hub",
    defaultSeverity: "advice",
    run: ({ bundle, incomingByConceptId, outgoingByConceptId }) => bundle.concepts
      .filter((concept) => ((incomingByConceptId.get(concept.id) ?? 0) + (outgoingByConceptId.get(concept.id) ?? 0)) >= DEFAULT_HIGH_DEGREE_THRESHOLD)
      .map((concept) => conceptDiagnostic("graph/high-degree-hub", "advice", concept, "Concept has unusually high graph degree and may need a hub/index split."))
  },
  {
    id: "graph/circular-reference",
    defaultSeverity: "warning",
    run: ({ bundle }) => findCircularReferences(bundle)
  },
  {
    id: "style/frontmatter-key-order",
    defaultSeverity: "warning",
    run: ({ bundle, config }) => {
      const configuredOrder = config.frontmatter.keyOrder;
      const ranks = buildStringRanks(configuredOrder);
      return bundle.concepts
        .filter((concept) => !frontmatterKeyOrderIsStable(concept, ranks, configuredOrder.length))
        .map((concept) => conceptDiagnostic("style/frontmatter-key-order", "warning", concept, "Frontmatter keys should use the configured stable order."));
    }
  },
  {
    id: "style/timestamp-format",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => concept.timestamp !== undefined && !isIsoTimestamp(concept.timestamp))
      .map((concept) => conceptDiagnostic("style/timestamp-format", "warning", concept, "Timestamp should be an ISO-8601 UTC timestamp."))
  },
  {
    id: "style/tag-format",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts.flatMap((concept) => (concept.tags ?? [])
      .filter((tag) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag))
      .map((tag) => conceptDiagnostic("style/tag-format", "warning", concept, `Tag "${tag}" should be lowercase kebab-case.`)))
  },
  {
    id: "style/file-name-format",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => !/^[a-z0-9][a-z0-9_./-]*\.md$/.test(concept.path))
      .map((concept) => conceptDiagnostic("style/file-name-format", "warning", concept, "Concept file path should be lowercase and URL-friendly."))
  },
  {
    id: "agent/missing-summary",
    defaultSeverity: "off",
    run: ({ bundle }) => missingSummaryDiagnostics(bundle)
  },
  {
    id: "agent/missing-usage",
    defaultSeverity: "off",
    run: ({ bundle }) => missingUsageDiagnostics(bundle)
  },
  {
    id: "agent/missing-owner",
    defaultSeverity: "off",
    run: ({ bundle }) => missingOwnerDiagnostics(bundle)
  },
  {
    id: "agent/metric-missing-source",
    defaultSeverity: "off",
    run: ({ bundle }) => metricMissingSourceDiagnostics(bundle)
  },
  {
    id: "agent/runbook-missing-symptoms",
    defaultSeverity: "off",
    run: ({ bundle }) => runbookMissingSymptomsDiagnostics(bundle)
  },
  {
    id: "agent/api-missing-auth-notes",
    defaultSeverity: "off",
    run: ({ bundle }) => apiMissingAuthNotesDiagnostics(bundle)
  },
  {
    id: "security/suspicious-secret",
    defaultSeverity: "error",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => containsSuspiciousSecret(conceptSearchableText(concept)))
      .map((concept) => conceptDiagnostic("security/suspicious-secret", "error", concept, "Concept appears to contain a secret or token."))
  },
  {
    id: "security/private-key",
    defaultSeverity: "error",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => containsPrivateKey(conceptSearchableText(concept)))
      .map((concept) => conceptDiagnostic("security/private-key", "error", concept, "Concept appears to contain a private key."))
  },
  {
    id: "security/token-looking-value",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => containsTokenLookingValue(conceptSearchableText(concept)))
      .map((concept) => conceptDiagnostic("security/token-looking-value", "warning", concept, "Concept appears to contain a token-looking value."))
  },
  {
    id: "security/unredacted-email",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => containsUnredactedEmail(conceptSearchableText(concept)))
      .map((concept) => conceptDiagnostic("security/unredacted-email", "warning", concept, "Concept appears to contain an unredacted email address."))
  },
  {
    id: "security/internal-url",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => containsInternalUrl(conceptTextWithoutResources(concept)))
      .map((concept) => conceptDiagnostic("security/internal-url", "warning", concept, "Concept contains an internal or private URL outside the resource field."))
  },
  {
    id: "security/private-url",
    defaultSeverity: "warning",
    run: ({ bundle }) => bundle.concepts.flatMap((concept) => resourceValues(concept)
      .filter((resource) => isPrivateUrl(resource))
      .map((resource) => conceptDiagnostic("security/private-url", "warning", concept, `Resource URL "${resource}" points to a private or local host.`)))
  },
  {
    id: "security/non-allowlisted-resource",
    defaultSeverity: "error",
    run: ({ bundle, config }) => {
      if (config.resourcePolicy.allowHosts.length === 0) {
        return [];
      }

      const allowed = new Set(config.resourcePolicy.allowHosts.flatMap(configuredHostAliases));
      return bundle.concepts.flatMap((concept) => resourceValues(concept)
        .filter((resource) => resourceHost(resource) !== undefined)
        .filter((resource) => !allowed.has(resourceHost(resource)!))
        .map((resource) => conceptDiagnostic("security/non-allowlisted-resource", "error", concept, `Resource URL "${resource}" is outside the configured allowlist.`)));
    }
  }
];

function runRule(rule: BuiltInRule, context: RuleContext): DiagnosticIR[] {
  const severity = resolveRuleLevel(configuredRule(context.config, rule.id), rule.defaultSeverity);
  if (severity === "off") {
    return [];
  }

  return rule.run(context).map((diagnostic) => ({
    ...diagnostic,
    severity
  }));
}

function configuredValidationDiagnostics(bundle: BundleIR, config: ResolvedOkfxConfig): DiagnosticIR[] {
  return validateBundle(bundle).diagnostics.flatMap((diagnostic) => {
    const severity = resolveRuleLevel(configuredRule(config, diagnostic.code), diagnostic.severity);
    return severity === "off" ? [] : [{ ...diagnostic, severity }];
  });
}

async function runPluginRules(plugins: LoadedOkfxPlugin[], context: RuleContext): Promise<DiagnosticIR[]> {
  const diagnostics: DiagnosticIR[] = [];

  for (const plugin of plugins) {
    for (const [ruleId, rule] of Object.entries(plugin.rules)) {
      if (resolveRuleLevel(configuredRule(context.config, ruleId), "warning") === "off") {
        continue;
      }

      try {
        const severity = resolveRuleLevel(configuredRule(context.config, ruleId), pluginRuleDefaultSeverity(rule));
        if (severity === "off") {
          continue;
        }
        const ruleDiagnostics: unknown = await rule.run({
          bundle: context.bundle,
          config: context.config,
          plugin,
          options: plugin.options
        });
        if (!Array.isArray(ruleDiagnostics)) {
          throw new TypeError("rule result must be an array of diagnostics");
        }
        diagnostics.push(...Array.from(ruleDiagnostics, (diagnostic) => normalizePluginDiagnostic(
          diagnostic,
          ruleId,
          severity
        )));
      } catch (error) {
        diagnostics.push({
          code: "plugin/rule-failed",
          severity: "error",
          message: `Plugin rule "${ruleId}" from "${plugin.name}" failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  return diagnostics;
}

function configuredRule(config: ResolvedOkfxConfig, ruleId: string) {
  return Object.hasOwn(config.rules, ruleId) ? config.rules[ruleId] : undefined;
}

function pluginRuleDefaultSeverity(rule: LoadedOkfxPlugin["rules"][string]): DiagnosticSeverity {
  const configuredMeta = ownProperty(rule, "meta");
  const meta = isRecord(configuredMeta) ? configuredMeta : undefined;
  const severity = meta
    ? ownProperty(meta, "defaultSeverity") ?? ownProperty(meta, "severity") ?? "warning"
    : "warning";
  if (severity !== "error" && severity !== "warning" && severity !== "advice" && severity !== "info") {
    throw new TypeError(`unsupported default severity ${JSON.stringify(severity)}`);
  }
  return severity;
}

function normalizePluginDiagnostic(
  value: unknown,
  ruleId: string,
  severity: DiagnosticSeverity
): DiagnosticIR {
  if (!isRecord(value)) {
    throw new TypeError("rule diagnostics must be objects");
  }

  const configuredCode = ownProperty(value, "code");
  const code = configuredCode === undefined || configuredCode === ""
    ? ruleId
    : requiredPluginString(configuredCode, "code");
  return {
    code,
    severity,
    message: requiredPluginString(ownProperty(value, "message"), "message"),
    ...optionalPluginStringField(value, "path"),
    ...optionalPluginStringField(value, "conceptId"),
    ...optionalPluginStringField(value, "docsUrl"),
    ...normalizePluginLocation(ownProperty(value, "location")),
    ...normalizePluginFix(ownProperty(value, "fix"))
  };
}

function normalizePluginLocation(value: unknown): Pick<DiagnosticIR, "location"> | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError("diagnostic location must be an object");
  }

  const start = normalizePluginSourceLocation(ownProperty(value, "start"), "location.start");
  const configuredEnd = ownProperty(value, "end");
  const end = configuredEnd === undefined
    ? undefined
    : normalizePluginSourceLocation(configuredEnd, "location.end");
  if (
    end
    && (
      end.line < start.line
      || (end.line === start.line && end.column < start.column)
      || (end.offset !== undefined && start.offset !== undefined && end.offset < start.offset)
    )
  ) {
    throw new TypeError("diagnostic location end must not precede its start");
  }
  return { location: { start, ...(end ? { end } : {}) } };
}

function normalizePluginSourceLocation(value: unknown, label: string): NonNullable<DiagnosticIR["location"]>["start"] {
  if (!isRecord(value)) {
    throw new TypeError(`diagnostic ${label} must be an object`);
  }
  const line = requiredPluginInteger(ownProperty(value, "line"), `${label}.line`, 1);
  const column = requiredPluginInteger(ownProperty(value, "column"), `${label}.column`, 1);
  const configuredOffset = ownProperty(value, "offset");
  const offset = configuredOffset === undefined
    ? undefined
    : requiredPluginInteger(configuredOffset, `${label}.offset`, 0);
  return { line, column, ...(offset === undefined ? {} : { offset }) };
}

function normalizePluginFix(value: unknown): Pick<DiagnosticIR, "fix"> | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError("diagnostic fix must be an object");
  }
  const configuredReplacement = ownProperty(value, "replacement");
  const replacement = configuredReplacement === undefined
    ? undefined
    : requiredPluginString(configuredReplacement, "fix.replacement");
  return {
    fix: {
      description: requiredPluginString(ownProperty(value, "description"), "fix.description"),
      ...(replacement === undefined ? {} : { replacement })
    }
  };
}

function optionalPluginStringField(
  value: Record<string, unknown>,
  key: "path" | "conceptId" | "docsUrl"
): Partial<Pick<DiagnosticIR, typeof key>> {
  const configuredValue = ownProperty(value, key);
  if (configuredValue === undefined) {
    return {};
  }
  const normalized = key === "path"
    ? requiredPluginPath(configuredValue)
    : requiredPluginString(configuredValue, key);
  return { [key]: normalized };
}

function requiredPluginPath(value: unknown): string {
  const path = requiredPluginString(value, "path");
  const normalized = normalizeRelativePath(path);
  if (
    path.length === 0
    || normalized !== path
    || normalized === ".."
    || normalized.startsWith("../")
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || /^[A-Za-z]:/.test(path)
  ) {
    throw new TypeError("diagnostic path must be a normalized, portable relative path");
  }
  return path;
}

function requiredPluginString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`diagnostic ${label} must be a string`);
  }
  return value;
}

function requiredPluginInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`diagnostic ${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownProperty<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function createRuleContext(bundle: BundleIR, config: ResolvedOkfxConfig): RuleContext {
  const pathsBySourceId = new Map<string, string>();
  for (const concept of bundle.concepts) {
    pathsBySourceId.set(concept.id, concept.path);
  }
  for (const index of bundle.indexes) {
    pathsBySourceId.set(conceptIdFromPath(index.path), index.path);
  }
  for (const log of bundle.logs) {
    pathsBySourceId.set(conceptIdFromPath(log.path), log.path);
  }

  const conceptIds = new Set(bundle.concepts.map((concept) => concept.id));
  const incomingSources = new Map<string, Set<string>>();
  const outgoingTargets = new Map<string, Set<string>>();
  for (const link of bundle.links) {
    if (link.kind !== "internal" || !link.resolved || !link.targetConceptId || !conceptIds.has(link.targetConceptId)) {
      continue;
    }
    incomingSources.set(link.targetConceptId, setAdd(incomingSources.get(link.targetConceptId), link.sourceConceptId));
    if (conceptIds.has(link.sourceConceptId)) {
      outgoingTargets.set(link.sourceConceptId, setAdd(outgoingTargets.get(link.sourceConceptId), link.targetConceptId));
    }
  }
  const incomingByConceptId = new Map([...incomingSources].map(([id, sources]) => [id, sources.size]));
  const outgoingByConceptId = new Map([...outgoingTargets].map(([id, targets]) => [id, targets.size]));

  return {
    bundle,
    config,
    pathsBySourceId,
    incomingByConceptId,
    outgoingByConceptId
  };
}

function setAdd<T>(set: Set<T> | undefined, value: T): Set<T> {
  const next = set ?? new Set<T>();
  next.add(value);
  return next;
}

function conceptDiagnostic(
  code: string,
  severity: DiagnosticSeverity,
  concept: ConceptIR,
  message: string
): DiagnosticIR {
  return {
    code,
    severity,
    message,
    path: concept.path,
    conceptId: concept.id
  };
}

function linkDiagnostic(
  code: string,
  severity: DiagnosticSeverity,
  link: LinkIR,
  pathsBySourceId: Map<string, string>,
  message: string
): DiagnosticIR {
  return {
    code,
    severity,
    message,
    path: pathsBySourceId.get(link.sourceConceptId),
    conceptId: link.sourceConceptId,
    location: link.location
  };
}

function duplicateConceptValues(
  concepts: ConceptIR[],
  getValues: (concept: ConceptIR) => string | string[] | undefined,
  code: string,
  severity: DiagnosticSeverity,
  message: string
): DiagnosticIR[] {
  const conceptsByValue = new Map<string, ConceptIR[]>();
  for (const concept of concepts) {
    const values = getValues(concept);
    const normalizedValues = Array.isArray(values) ? values : values ? [values] : [];
    for (const value of new Set(normalizedValues.filter(Boolean))) {
      const duplicates = conceptsByValue.get(value);
      if (duplicates) {
        duplicates.push(concept);
      } else {
        conceptsByValue.set(value, [concept]);
      }
    }
  }

  return [...conceptsByValue.values()]
    .filter((duplicates) => duplicates.length > 1)
    .flatMap((duplicates) => duplicates.map((concept) => conceptDiagnostic(code, severity, concept, message)));
}

function resourceValues(concept: ConceptIR): string[] {
  if (Array.isArray(concept.resource)) {
    return concept.resource;
  }

  return concept.resource ? [concept.resource] : [];
}

function conceptSearchableText(concept: ConceptIR): string {
  return `${JSON.stringify(concept.frontmatter)}\n${concept.frontmatterRaw ?? ""}\n${concept.body.raw}`;
}

function conceptTextWithoutResources(concept: ConceptIR): string {
  const { resource: _resource, ...frontmatter } = concept.frontmatter;
  return `${JSON.stringify(frontmatter)}\n${concept.body.raw}`;
}

function frontmatterKeyOrderIsStable(
  concept: ConceptIR,
  ranks: ReadonlyMap<string, number>,
  fallbackRank: number
): boolean {
  if (concept.frontmatterRaw === undefined) {
    return true;
  }

  const keys = frontmatterKeys(concept.frontmatterRaw);
  const desired = [...keys].sort((a, b) => (
    (ranks.get(a) ?? fallbackRank) - (ranks.get(b) ?? fallbackRank) || compareStrings(a, b)
  ));
  return keys.join("\0") === desired.join("\0");
}

function frontmatterKeys(raw: string): string[] {
  const keys: string[] = [];
  let requiresYamlParsing = false;
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line.trim().length === 0
      || line.trimStart().startsWith("#")
      || line.startsWith(" ")
      || line.startsWith("\t")) {
      continue;
    }
    const key = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line)?.[1];
    if (key) {
      keys.push(key);
    } else {
      requiresYamlParsing = true;
      break;
    }
  }
  if (!requiresYamlParsing) {
    return keys;
  }

  try {
    const document = parseDocument(raw.replace(/\r\n?/g, "\n"), { prettyErrors: false });
    if (document.errors.length === 0 && isMap(document.contents)) {
      return document.contents.items.flatMap((pair) => (
        isScalar(pair.key) && typeof pair.key.value === "string" ? [pair.key.value] : []
      ));
    }
  } catch {
    // Invalid frontmatter is reported separately; retain the best-effort key scan here.
  }
  return keys;
}

function isIsoTimestamp(value: string): boolean {
  return parseIsoUtcTimestamp(value) !== undefined;
}

function containsSuspiciousSecret(value: string): boolean {
  return containsPrivateKey(value) || containsTokenLookingValue(value);
}

function containsPrivateKey(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function containsTokenLookingValue(value: string): boolean {
  return /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\b(?:api[_-]?key|secret|token)\b[^\S\r\n]*[:=][^\S\r\n]*["']?[A-Za-z0-9_.-]{20,}/i.test(value);
}

function containsUnredactedEmail(value: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value);
}

function containsInternalUrl(value: string): boolean {
  return extractUrls(value).some(isPrivateUrl);
}

function extractUrls(value: string): string[] {
  return (value.match(/\bhttps?:\/\/[^\s<>"']+/giu) ?? []).map(trimUrlCandidate);
}

function trimUrlCandidate(value: string): string {
  let openParentheses = 0;
  let closeParentheses = 0;
  let openBrackets = 0;
  let closeBrackets = 0;
  for (const character of value) {
    openParentheses += Number(character === "(");
    closeParentheses += Number(character === ")");
    openBrackets += Number(character === "[");
    closeBrackets += Number(character === "]");
  }

  let end = value.length;
  while (end > 0) {
    const character = value[end - 1];
    if (character && ".,;:!?".includes(character)) {
      end -= 1;
    } else if (character === ")" && closeParentheses > openParentheses) {
      closeParentheses -= 1;
      end -= 1;
    } else if (character === "]" && closeBrackets > openBrackets) {
      closeBrackets -= 1;
      end -= 1;
    } else {
      break;
    }
  }
  return value.slice(0, end);
}

function isPrivateUrl(value: string): boolean {
  const host = resourceHost(value);
  if (!host) {
    return false;
  }

  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host === "local"
    || host.endsWith(".local")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Host(host);
  if (ipv4) {
    return PRIVATE_IP_RANGES.check(ipv4, "ipv4");
  }

  const embeddedIpv4 = ipv4EmbeddedAddress(host);
  if (embeddedIpv4) {
    return PRIVATE_IP_RANGES.check(embeddedIpv4, "ipv4");
  }

  const family = isIP(host);
  return family !== 0 && PRIVATE_IP_RANGES.check(host, family === 4 ? "ipv4" : "ipv6");
}

function parseIpv4Host(host: string): string | undefined {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4 || parts.some((part) => part.length === 0)) {
    return undefined;
  }
  const numbers = parts.map(parseIpv4Number);
  if (numbers.some((number) => number === undefined)) {
    return undefined;
  }
  const values = numbers as number[];
  if (values.slice(0, -1).some((number) => number > 255)) {
    return undefined;
  }

  const finalBits = 8 * (5 - values.length);
  const finalLimit = 2 ** finalBits;
  const finalNumber = values.at(-1)!;
  if (finalNumber >= finalLimit) {
    return undefined;
  }

  let address = finalNumber;
  values.slice(0, -1).forEach((number, index) => {
    address += number * (2 ** (8 * (3 - index)));
  });
  return [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join(".");
}

function parseIpv4Number(value: string): number | undefined {
  let radix = 10;
  let digits = value;
  if (/^0x/iu.test(value)) {
    radix = 16;
    digits = value.slice(2);
  } else if (value.length > 1 && value.startsWith("0")) {
    radix = 8;
    digits = value.slice(1);
  }
  const valid = radix === 16 ? /^[0-9a-f]+$/iu : (radix === 8 ? /^[0-7]+$/u : /^[0-9]+$/u);
  if (!valid.test(digits)) {
    return undefined;
  }
  const number = Number.parseInt(digits, radix);
  return number <= 0xffff_ffff ? number : undefined;
}

function ipv4EmbeddedAddress(host: string): string | undefined {
  const match = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(host);
  if (!match) {
    return undefined;
  }
  const high = Number.parseInt(match[1] ?? "", 16);
  const low = Number.parseInt(match[2] ?? "", 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function resourceHost(value: string): string | undefined {
  try {
    const host = new URL(value).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/u, "")
      .toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

function configuredHostAliases(value: string): string[] {
  const literal = value.toLowerCase();
  const authority = literal.includes(":") ? `[${literal}]` : literal;
  const aliases = new Set([literal]);
  const candidates = literal.includes("%")
    ? [`okfx://${authority}`]
    : [`http://${authority}`, `okfx://${authority}`];
  for (const candidate of candidates) {
    const canonical = resourceHost(candidate);
    if (canonical) {
      aliases.add(canonical);
    }
  }
  return [...aliases];
}

function createPrivateIpRanges(): BlockList {
  const ranges = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16]
  ] as const) {
    ranges.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10]
  ] as const) {
    ranges.addSubnet(network, prefix, "ipv6");
  }
  return ranges;
}

function findCircularReferences(bundle: BundleIR): DiagnosticIR[] {
  const conceptsById = new Map(bundle.concepts.map((concept) => [concept.id, concept]));
  return buildGraph(bundle).analysis.cycles.flatMap((cycle) => {
    const concept = conceptsById.get(cycle[0]);
    return concept
      ? [conceptDiagnostic(
        "graph/circular-reference",
        "warning",
        concept,
        `Circular concept reference detected: ${cycle.join(" -> ")}.`
      )]
      : [];
  });
}
