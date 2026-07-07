import { conceptIdFromPath } from "./paths.js";
import { countDiagnostics, diagnosticsExceedThreshold, sortDiagnostics, type DiagnosticCounts } from "./diagnostics.js";
import { resolveConfig, type OkfxConfig, type ResolvedOkfxConfig, type RuleConfig } from "./config.js";
import { validateBundle } from "./validation.js";
import type { BundleIR, ConceptIR, DiagnosticIR, DiagnosticSeverity, LinkIR } from "./types.js";

export interface LintOptions {
  config?: OkfxConfig | ResolvedOkfxConfig;
}

export interface LintResult {
  ok: boolean;
  diagnostics: DiagnosticIR[];
  counts: DiagnosticCounts;
  failOn: DiagnosticSeverity;
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
  defaultSeverity: DiagnosticSeverity;
  run: RuleRunner;
}

export function lintBundle(bundle: BundleIR, options: LintOptions = {}): LintResult {
  const config = resolveConfig(options.config ?? {});
  const context = createRuleContext(bundle, config);
  const diagnostics = sortDiagnostics([
    ...validateBundle(bundle).diagnostics,
    ...builtInLintRules.flatMap((rule) => runRule(rule, context))
  ]);
  const counts = countDiagnostics(diagnostics);

  return {
    ok: !diagnosticsExceedThreshold(diagnostics, config.failOn),
    diagnostics,
    counts,
    failOn: config.failOn
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
      (concept) => resourceValues(concept).map((resource) => resource.toLowerCase()),
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
    id: "security/suspicious-secret",
    defaultSeverity: "error",
    run: ({ bundle }) => bundle.concepts
      .filter((concept) => containsSuspiciousSecret(`${JSON.stringify(concept.frontmatter)}\n${concept.body.raw}`))
      .map((concept) => conceptDiagnostic("security/suspicious-secret", "error", concept, "Concept appears to contain a secret or token."))
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

function resolveRuleLevel(config: RuleConfig | undefined, defaultSeverity: DiagnosticSeverity): DiagnosticSeverity | "off" {
  const value = Array.isArray(config) ? config[0] : config;
  return value ?? defaultSeverity;
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

  const incomingByConceptId = new Map<string, number>();
  const outgoingByConceptId = new Map<string, number>();
  for (const link of bundle.links) {
    if (link.kind !== "internal" || !link.resolved || !link.targetConceptId) {
      continue;
    }
    incomingByConceptId.set(link.targetConceptId, (incomingByConceptId.get(link.targetConceptId) ?? 0) + 1);
    outgoingByConceptId.set(link.sourceConceptId, (outgoingByConceptId.get(link.sourceConceptId) ?? 0) + 1);
  }

  return {
    bundle,
    config,
    pathsBySourceId,
    incomingByConceptId,
    outgoingByConceptId
  };
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
    for (const value of normalizedValues) {
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
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function containsSuspiciousSecret(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\b(?:api[_-]?key|secret|token)\b\s*[:=]\s*["']?[A-Za-z0-9_.-]{20,}/i.test(value);
}

function isPrivateUrl(value: string): boolean {
  const host = resourceHost(value);
  if (!host) {
    return false;
  }

  return host === "localhost"
    || host === "127.0.0.1"
    || host.startsWith("10.")
    || host.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function resourceHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function findCircularReferences(bundle: BundleIR): DiagnosticIR[] {
  const conceptsById = new Map(bundle.concepts.map((concept) => [concept.id, concept]));
  const adjacency = new Map<string, string[]>();
  for (const link of bundle.links) {
    if (link.kind === "internal" && link.resolved && link.targetConceptId && conceptsById.has(link.sourceConceptId)) {
      adjacency.set(link.sourceConceptId, [...(adjacency.get(link.sourceConceptId) ?? []), link.targetConceptId]);
    }
  }

  const reported = new Set<string>();
  const diagnostics: DiagnosticIR[] = [];
  for (const concept of bundle.concepts) {
    const cycle = findCycleFrom(concept.id, adjacency);
    if (!cycle) {
      continue;
    }

    const key = [...cycle].sort().join(">");
    if (reported.has(key)) {
      continue;
    }

    reported.add(key);
    diagnostics.push(conceptDiagnostic(
      "graph/circular-reference",
      "warning",
      concept,
      `Circular concept reference detected: ${cycle.join(" -> ")}.`
    ));
  }

  return diagnostics;
}

function findCycleFrom(start: string, adjacency: Map<string, string[]>): string[] | undefined {
  const stack: string[] = [];
  const visited = new Set<string>();

  function visit(id: string): string[] | undefined {
    if (stack.includes(id)) {
      return [...stack.slice(stack.indexOf(id)), id];
    }

    if (visited.has(id)) {
      return undefined;
    }

    visited.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    return undefined;
  }

  return visit(start);
}
