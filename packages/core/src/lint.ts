import { BlockList, isIP } from "node:net";

import { conceptIdFromPath } from "./paths.js";
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
    run: ({ bundle, config }) => bundle.concepts
      .filter((concept) => !frontmatterKeyOrderIsStable(concept, config.frontmatter.keyOrder))
      .map((concept) => conceptDiagnostic("style/frontmatter-key-order", "warning", concept, "Frontmatter keys should use the configured stable order."))
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

      const allowed = new Set(config.resourcePolicy.allowHosts.map((host) => host.toLowerCase()));
      return bundle.concepts.flatMap((concept) => resourceValues(concept)
        .filter((resource) => resourceHost(resource) !== undefined)
        .filter((resource) => !allowed.has(resourceHost(resource)!))
        .map((resource) => conceptDiagnostic("security/non-allowlisted-resource", "error", concept, `Resource URL "${resource}" is outside the configured allowlist.`)));
    }
  }
];

function runRule(rule: BuiltInRule, context: RuleContext): DiagnosticIR[] {
  const severity = resolveRuleLevel(context.config.rules[rule.id], rule.defaultSeverity);
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
    const severity = resolveRuleLevel(config.rules[diagnostic.code], diagnostic.severity);
    return severity === "off" ? [] : [{ ...diagnostic, severity }];
  });
}

async function runPluginRules(plugins: LoadedOkfxPlugin[], context: RuleContext): Promise<DiagnosticIR[]> {
  const diagnostics: DiagnosticIR[] = [];

  for (const plugin of plugins) {
    for (const [ruleId, rule] of Object.entries(plugin.rules)) {
      const severity = resolveRuleLevel(
        context.config.rules[ruleId],
        rule.meta?.defaultSeverity ?? rule.meta?.severity ?? "warning"
      );
      if (severity === "off") {
        continue;
      }

      try {
        const ruleDiagnostics = await rule.run({
          bundle: context.bundle,
          config: context.config,
          plugin,
          options: plugin.options
        });
        diagnostics.push(...ruleDiagnostics.map((diagnostic) => ({
          ...diagnostic,
          code: diagnostic.code || ruleId,
          severity
        })));
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
      conceptsByValue.set(value, [...(conceptsByValue.get(value) ?? []), concept]);
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

function frontmatterKeyOrderIsStable(concept: ConceptIR, configuredOrder: string[]): boolean {
  if (concept.frontmatterRaw === undefined) {
    return true;
  }

  const keys = concept.frontmatterRaw
    .split(/\r?\n/)
    .map((line) => /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
  const desired = [...keys].sort((a, b) => frontmatterKeyRank(a, configuredOrder) - frontmatterKeyRank(b, configuredOrder) || a.localeCompare(b));
  return keys.join("\0") === desired.join("\0");
}

function frontmatterKeyRank(key: string, configuredOrder: string[]): number {
  const index = configuredOrder.indexOf(key);
  return index === -1 ? configuredOrder.length : index;
}

function isIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/.exec(value);
  if (!match) {
    return false;
  }

  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number
  ];
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month)
    && hour <= 23
    && minute <= 59
    && second <= 59;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function containsSuspiciousSecret(value: string): boolean {
  return containsPrivateKey(value) || containsTokenLookingValue(value);
}

function containsPrivateKey(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function containsTokenLookingValue(value: string): boolean {
  return /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\b(?:api[_-]?key|secret|token)\b\s*[:=]\s*["']?[A-Za-z0-9_.-]{20,}/i.test(value);
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
  let trimmed = value;
  while (trimmed.length > 0) {
    const withoutSentencePunctuation = trimmed.replace(/[.,;:!?]+$/u, "");
    if (withoutSentencePunctuation !== trimmed) {
      trimmed = withoutSentencePunctuation;
      continue;
    }
    if (trimmed.endsWith(")") && countCharacter(trimmed, ")") > countCharacter(trimmed, "(")) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    if (trimmed.endsWith("]") && countCharacter(trimmed, "]") > countCharacter(trimmed, "[")) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    break;
  }
  return trimmed;
}

function countCharacter(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length;
}

function isPrivateUrl(value: string): boolean {
  const host = resourceHost(value);
  if (!host) {
    return false;
  }

  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  const mappedIpv4 = ipv4MappedAddress(host);
  if (mappedIpv4) {
    return PRIVATE_IP_RANGES.check(mappedIpv4, "ipv4");
  }

  const family = isIP(host);
  return family !== 0 && PRIVATE_IP_RANGES.check(host, family === 4 ? "ipv4" : "ipv6");
}

function ipv4MappedAddress(host: string): string | undefined {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(host);
  if (!match) {
    return undefined;
  }
  const high = Number.parseInt(match[1] ?? "", 16);
  const low = Number.parseInt(match[2] ?? "", 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function resourceHost(value: string): string | undefined {
  try {
    return new URL(value).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/u, "")
      .toLowerCase();
  } catch {
    return undefined;
  }
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
