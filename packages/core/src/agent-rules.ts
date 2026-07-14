import { parseIsoUtcTimestamp } from "./timestamp.js";
import type { BundleIR, ConceptIR, DiagnosticIR, DiagnosticSeverity } from "./types.js";

export function missingOwnerDiagnostics(bundle: BundleIR): DiagnosticIR[] {
  return bundle.concepts
    .filter((concept) => ["api", "metric", "runbook"].includes(concept.type.toLowerCase()))
    .filter((concept) => stringFrontmatter(concept, "owner").trim().length === 0)
    .map((concept) => conceptDiagnostic("agent/missing-owner", "advice", concept, "Production-facing concepts should declare an owner."));
}

export function missingSummaryDiagnostics(bundle: BundleIR): DiagnosticIR[] {
  return bundle.concepts
    .filter((concept) => !hasHeading(concept, "summary") && !concept.description?.trim())
    .map((concept) => conceptDiagnostic("agent/missing-summary", "advice", concept, "Concept should provide a summary through description or a Summary section."));
}

export function missingUsageDiagnostics(bundle: BundleIR): DiagnosticIR[] {
  return bundle.concepts
    .filter((concept) => ["api", "metric"].includes(concept.type.toLowerCase()))
    .filter((concept) => !hasHeading(concept, "usage"))
    .map((concept) => conceptDiagnostic("agent/missing-usage", "advice", concept, "Agent-facing API and metric concepts should include a Usage section."));
}

export function metricMissingSourceDiagnostics(bundle: BundleIR): DiagnosticIR[] {
  const conceptsById = new Map(bundle.concepts.map((concept) => [concept.id, concept]));
  return bundle.concepts
    .filter((concept) => concept.type.toLowerCase() === "metric")
    .filter((concept) => !linksToType(concept, conceptsById, "table"))
    .map((concept) => conceptDiagnostic("agent/metric-missing-source", "warning", concept, "Metric should link to at least one source table concept."));
}

export function runbookMissingSymptomsDiagnostics(bundle: BundleIR): DiagnosticIR[] {
  return bundle.concepts
    .filter((concept) => concept.type.toLowerCase() === "runbook")
    .filter((concept) => !hasHeading(concept, "symptoms"))
    .map((concept) => conceptDiagnostic("agent/runbook-missing-symptoms", "warning", concept, "Runbook should include a Symptoms section."));
}

export function apiMissingAuthNotesDiagnostics(bundle: BundleIR): DiagnosticIR[] {
  return bundle.concepts
    .filter((concept) => concept.type.toLowerCase() === "api")
    .filter((concept) => !headings(concept).some(isAuthHeading))
    .map((concept) => conceptDiagnostic("agent/api-missing-auth-notes", "advice", concept, "API concept should include authentication notes."));
}

export function staleTimestampDiagnostics(bundle: BundleIR, now: Date): DiagnosticIR[] {
  return bundle.concepts
    .filter((concept) => concept.timestamp && timestampIsStale(concept.timestamp, now))
    .map((concept) => conceptDiagnostic("agent/stale-timestamp", "warning", concept, "Concept timestamp is older than 180 days."));
}

export function deprecatedMissingReplacementDiagnostics(bundle: BundleIR): DiagnosticIR[] {
  return bundle.concepts
    .filter(isDeprecatedConcept)
    .filter((concept) => !hasDeprecationPath(concept))
    .map((concept) => conceptDiagnostic("agent/deprecated-missing-replacement", "warning", concept, "Deprecated concept should identify a replacement, migration path, or deprecation notes."));
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

function headings(concept: ConceptIR): string[] {
  return concept.body.headings.map((heading) => heading.title.toLowerCase());
}

function hasHeading(concept: ConceptIR, expected: string): boolean {
  return headings(concept).some((heading) => heading === expected || heading.endsWith(` ${expected}`));
}

function isAuthHeading(heading: string): boolean {
  return /\b(?:auth(?:entication|orization|n|z)?|oauth2?)\b/.test(heading);
}

function linksToType(
  concept: ConceptIR,
  conceptsById: ReadonlyMap<string, ConceptIR>,
  targetType: string
): boolean {
  return concept.links.some((link) => {
    if (link.kind !== "internal" || !link.resolved || !link.targetConceptId) {
      return false;
    }
    return conceptsById.get(link.targetConceptId)?.type.toLowerCase() === targetType;
  });
}

function timestampIsStale(timestamp: string, now: Date): boolean {
  const parsed = parseIsoUtcTimestamp(timestamp);
  if (parsed === undefined) {
    return false;
  }
  return now.getTime() - parsed > 180 * 24 * 60 * 60 * 1000;
}

function isDeprecatedConcept(concept: ConceptIR): boolean {
  return stringFrontmatter(concept, "status").toLowerCase() === "deprecated"
    || (concept.tags ?? []).some((tag) => tag.toLowerCase() === "deprecated");
}

function hasDeprecationPath(concept: ConceptIR): boolean {
  return ["replacement", "replaced_by", "replacedBy", "superseded_by", "supersededBy"]
    .some((key) => stringFrontmatter(concept, key).trim().length > 0)
    || headings(concept).some((heading) => heading.includes("replacement") || heading.includes("migration") || heading.includes("deprecation"));
}

function stringFrontmatter(concept: ConceptIR, key: string): string {
  const value = Object.hasOwn(concept.frontmatter, key)
    ? concept.frontmatter[key]
    : undefined;
  return typeof value === "string" ? value : "";
}
