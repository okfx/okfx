import { countDiagnostics, diagnosticsExceedThreshold, sortDiagnostics, type DiagnosticCounts } from "./diagnostics.js";
import { buildGraph } from "./graph.js";
import { lintBundle } from "./lint.js";
import { resolveConfig, type OkfxConfig, type ResolvedOkfxConfig } from "./config.js";
import type { BundleIR, ConceptIR, DiagnosticIR, DiagnosticSeverity } from "./types.js";

export interface DoctorOptions {
  config?: OkfxConfig | ResolvedOkfxConfig;
  now?: Date;
}

export interface DoctorResult {
  ok: boolean;
  score: number;
  diagnostics: DiagnosticIR[];
  counts: DiagnosticCounts;
  failOn: DiagnosticSeverity;
  highImpactDiagnostics: DiagnosticIR[];
  summary: {
    conceptCount: number;
    linkCount: number;
    brokenLinkCount: number;
    orphanCount: number;
    cycleCount: number;
  };
}

export function doctorBundle(bundle: BundleIR, options: DoctorOptions = {}): DoctorResult {
  const config = resolveConfig(options.config ?? {});
  const graph = buildGraph(bundle);
  const lint = lintBundle(bundle, { config });
  const diagnostics = sortDiagnostics([
    ...lint.diagnostics,
    ...doctorDiagnostics(bundle, options.now ?? new Date())
  ]);
  const counts = countDiagnostics(diagnostics);
  const score = readinessScore(counts);

  return {
    ok: !diagnosticsExceedThreshold(diagnostics, config.failOn),
    score,
    diagnostics,
    counts,
    failOn: config.failOn,
    highImpactDiagnostics: diagnostics.filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning"),
    summary: {
      conceptCount: bundle.stats.conceptCount,
      linkCount: bundle.stats.linkCount,
      brokenLinkCount: graph.stats.brokenLinkCount,
      orphanCount: graph.stats.orphanCount,
      cycleCount: graph.stats.cycleCount
    }
  };
}

function doctorDiagnostics(bundle: BundleIR, now: Date): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];

  if (bundle.indexes.length === 0) {
    diagnostics.push({
      code: "agent/missing-index",
      severity: "warning",
      message: "Bundle should include index.md so humans and agents have a navigable entrypoint."
    });
  }

  for (const concept of bundle.concepts) {
    diagnostics.push(...conceptDoctorDiagnostics(concept, bundle, now));
  }

  return diagnostics;
}

function conceptDoctorDiagnostics(concept: ConceptIR, bundle: BundleIR, now: Date): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];
  const type = concept.type.toLowerCase();
  const headings = concept.body.headings.map((heading) => heading.title.toLowerCase());

  if (!concept.frontmatter.owner && ["api", "metric", "runbook"].includes(type)) {
    diagnostics.push(conceptDiagnostic("agent/missing-owner", "advice", concept, "Production-facing concepts should declare an owner."));
  }

  if (!hasHeading(headings, "summary") && !concept.description) {
    diagnostics.push(conceptDiagnostic("agent/missing-summary", "advice", concept, "Concept should provide a summary through description or a Summary section."));
  }

  if (["api", "metric"].includes(type) && !hasHeading(headings, "usage")) {
    diagnostics.push(conceptDiagnostic("agent/missing-usage", "advice", concept, "Agent-facing API and metric concepts should include a Usage section."));
  }

  if (type === "metric" && !linksToType(concept, bundle, "table")) {
    diagnostics.push(conceptDiagnostic("agent/metric-missing-source", "warning", concept, "Metric should link to at least one source table concept."));
  }

  if (type === "runbook" && !hasHeading(headings, "symptoms")) {
    diagnostics.push(conceptDiagnostic("agent/runbook-missing-symptoms", "warning", concept, "Runbook should include a Symptoms section."));
  }

  if (type === "api" && !headings.some((heading) => heading.includes("auth"))) {
    diagnostics.push(conceptDiagnostic("agent/api-missing-auth-notes", "advice", concept, "API concept should include authentication notes."));
  }

  if (concept.timestamp && timestampIsStale(concept.timestamp, now)) {
    diagnostics.push(conceptDiagnostic("agent/stale-timestamp", "warning", concept, "Concept timestamp is older than 180 days."));
  }

  if (isDeprecatedConcept(concept) && !hasDeprecationPath(concept, headings)) {
    diagnostics.push(conceptDiagnostic("agent/deprecated-missing-replacement", "warning", concept, "Deprecated concept should identify a replacement, migration path, or deprecation notes."));
  }

  return diagnostics;
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

function hasHeading(headings: string[], expected: string): boolean {
  return headings.some((heading) => heading === expected || heading.endsWith(` ${expected}`));
}

function linksToType(concept: ConceptIR, bundle: BundleIR, targetType: string): boolean {
  const conceptsById = new Map(bundle.concepts.map((item) => [item.id, item]));
  return concept.links.some((link) => {
    if (link.kind !== "internal" || !link.resolved || !link.targetConceptId) {
      return false;
    }

    return conceptsById.get(link.targetConceptId)?.type.toLowerCase() === targetType;
  });
}

function timestampIsStale(timestamp: string, now: Date): boolean {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return false;
  }

  const maxAgeMs = 180 * 24 * 60 * 60 * 1000;
  return now.getTime() - parsed > maxAgeMs;
}

function isDeprecatedConcept(concept: ConceptIR): boolean {
  return stringFrontmatter(concept, "status").toLowerCase() === "deprecated"
    || (concept.tags ?? []).some((tag) => tag.toLowerCase() === "deprecated");
}

function hasDeprecationPath(concept: ConceptIR, headings: string[]): boolean {
  return ["replacement", "replaced_by", "replacedBy", "superseded_by", "supersededBy"]
    .some((key) => stringFrontmatter(concept, key).trim().length > 0)
    || headings.some((heading) => heading.includes("replacement") || heading.includes("migration") || heading.includes("deprecation"));
}

function stringFrontmatter(concept: ConceptIR, key: string): string {
  const value = concept.frontmatter[key];
  return typeof value === "string" ? value : "";
}

function readinessScore(counts: DiagnosticCounts): number {
  return Math.max(0, 100 - counts.error * 20 - counts.warning * 8 - counts.advice * 3);
}
