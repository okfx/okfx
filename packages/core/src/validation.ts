import { normalizeRelativePath } from "./paths.js";
import { countDiagnostics, sortDiagnostics, type DiagnosticCounts } from "./diagnostics.js";
import type { BundleIR, ConceptIR, DiagnosticIR } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  diagnostics: DiagnosticIR[];
  counts: DiagnosticCounts;
}

export function validateBundle(bundle: BundleIR): ValidationResult {
  const diagnostics = sortDiagnostics([
    ...bundle.diagnostics,
    ...bundle.concepts.flatMap((concept) => validateConcept(concept, bundle.diagnostics))
  ]);
  const counts = countDiagnostics(diagnostics);

  return {
    ok: counts.error === 0,
    diagnostics,
    counts
  };
}

function validateConcept(concept: ConceptIR, existingDiagnostics: DiagnosticIR[]): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];
  const hasInvalidFrontmatter = existingDiagnostics.some(
    (diagnostic) => diagnostic.path === concept.path && diagnostic.code === "spec/invalid-frontmatter"
  );

  if (concept.frontmatterRaw === undefined) {
    diagnostics.push({
      code: "spec/missing-frontmatter",
      severity: "error",
      message: "Concept document must include parseable YAML frontmatter.",
      path: concept.path,
      conceptId: concept.id,
      location: {
        start: {
          line: 1,
          column: 1,
          offset: 0
        }
      }
    });
    return diagnostics;
  }

  if (!hasInvalidFrontmatter && concept.type.trim().length === 0) {
    diagnostics.push({
      code: "spec/missing-type",
      severity: "error",
      message: "Concept document must include non-empty frontmatter field \"type\".",
      path: concept.path,
      conceptId: concept.id,
      location: {
        start: {
          line: 1,
          column: 1,
          offset: 0
        }
      }
    });
  }

  if (!isValidConceptPath(concept.path)) {
    diagnostics.push({
      code: "spec/invalid-concept-path",
      severity: "error",
      message: "Concept path must be normalized, relative, and end in .md.",
      path: concept.path,
      conceptId: concept.id
    });
  }

  return diagnostics;
}

function isValidConceptPath(path: string): boolean {
  if (!path.endsWith(".md")) {
    return false;
  }

  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }

  const normalized = normalizeRelativePath(path);
  return normalized === path && !normalized.startsWith("../") && normalized !== "..";
}
