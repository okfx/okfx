import { compareStrings } from "./compare.js";
import type { DiagnosticIR, DiagnosticSeverity } from "./types.js";

const severityRank: Record<DiagnosticSeverity, number> = {
  error: 4,
  warning: 3,
  advice: 2,
  info: 1
};

export interface DiagnosticCounts {
  error: number;
  warning: number;
  advice: number;
  info: number;
}

export function countDiagnostics(diagnostics: DiagnosticIR[]): DiagnosticCounts {
  const counts: DiagnosticCounts = {
    error: 0,
    warning: 0,
    advice: 0,
    info: 0
  };

  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }

  return counts;
}

export function diagnosticsExceedThreshold(
  diagnostics: DiagnosticIR[],
  threshold: DiagnosticSeverity
): boolean {
  const thresholdRank = severityRank[threshold];
  return diagnostics.some((diagnostic) => severityRank[diagnostic.severity] >= thresholdRank);
}

export function sortDiagnostics(diagnostics: DiagnosticIR[]): DiagnosticIR[] {
  return [...diagnostics].sort((a, b) => {
    const severity = severityRank[b.severity] - severityRank[a.severity];
    if (severity !== 0) {
      return severity;
    }

    return [
      compareStrings(a.path ?? "", b.path ?? ""),
      compareStrings(a.code, b.code),
      compareStrings(a.message, b.message)
    ].find((value) => value !== 0) ?? 0;
  });
}
