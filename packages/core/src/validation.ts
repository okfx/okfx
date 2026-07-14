import { normalizeRelativePath } from "./paths.js";
import { countDiagnostics, sortDiagnostics, type DiagnosticCounts } from "./diagnostics.js";
import { isSupportedOkfVersion, supportedOkfVersions } from "./version.js";
import type { BundleIR, ConceptIR, DiagnosticIR } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  diagnostics: DiagnosticIR[];
  counts: DiagnosticCounts;
}

export function validateBundle(bundle: BundleIR): ValidationResult {
  const invalidFrontmatterPaths = new Set(bundle.diagnostics
    .filter((diagnostic) => diagnostic.code === "spec/invalid-frontmatter" && diagnostic.path !== undefined)
    .map((diagnostic) => diagnostic.path!));
  const diagnostics = sortDiagnostics([
    ...bundle.diagnostics,
    ...validateOkfVersion(bundle),
    ...bundle.concepts.flatMap((concept) => validateConcept(concept, invalidFrontmatterPaths))
  ]);
  const counts = countDiagnostics(diagnostics);

  return {
    ok: counts.error === 0,
    diagnostics,
    counts
  };
}

function validateOkfVersion(bundle: BundleIR): DiagnosticIR[] {
  if (isSupportedOkfVersion(bundle.okfVersion)) {
    return [];
  }

  return [{
    code: "spec/unsupported-okf-version",
    severity: "error",
    message: `Unsupported OKF version "${bundle.okfVersion ?? "(missing)"}". Supported versions: ${supportedOkfVersions.join(", ")}.`
  }];
}

function validateConcept(concept: ConceptIR, invalidFrontmatterPaths: ReadonlySet<string>): DiagnosticIR[] {
  const diagnostics: DiagnosticIR[] = [];
  const hasInvalidFrontmatter = invalidFrontmatterPaths.has(concept.path);

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
  const filename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const stem = filename.slice(0, -3);
  return normalized === path
    && !normalized.startsWith("../")
    && normalized !== ".."
    && stem !== ""
    && stem !== "."
    && stem !== "..";
}
