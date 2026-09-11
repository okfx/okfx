import {
  defaultConfig,
  resolveConfig,
  resolveRuleLevel,
  type OkfxConfig,
  type ResolvedOkfxConfig
} from "./config.js";
import { countDiagnostics, diagnosticsExceedThreshold, sortDiagnostics, type DiagnosticCounts } from "./diagnostics.js";
import {
  deprecatedMissingReplacementDiagnostics,
  staleTimestampDiagnostics
} from "./agent-rules.js";
import { buildGraph } from "./graph.js";
import { lintBundle } from "./lint.js";
import type { BundleIR, DiagnosticIR, DiagnosticSeverity } from "./types.js";

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
  const config = resolveDoctorConfig(options.config);
  const graph = buildGraph(bundle);
  const lint = lintBundle(bundle, { config });
  const diagnostics = sortDiagnostics([
    ...lint.diagnostics,
    ...doctorDiagnostics(bundle, options.now ?? new Date(), config)
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

function resolveDoctorConfig(input: OkfxConfig | ResolvedOkfxConfig | undefined): ResolvedOkfxConfig {
  const base = input ?? {};
  const configuredPresets = Object.hasOwn(base, "presets") ? base.presets : undefined;
  const presets = [...(configuredPresets ?? defaultConfig.presets)];
  if (!presets.some((preset) => preset.replace(/^@okfxjs\/preset-/, "").replace(/^preset-/, "") === "agent-ready")) {
    presets.push("agent-ready");
  }
  const configuredPath = Object.hasOwn(base, "configPath")
    ? (base as ResolvedOkfxConfig).configPath
    : undefined;
  const configPath = typeof configuredPath === "string" ? configuredPath : undefined;
  return resolveConfig({ ...base, presets }, configPath);
}

function doctorDiagnostics(bundle: BundleIR, now: Date, config: ResolvedOkfxConfig): DiagnosticIR[] {
  return [
    ...configuredDoctorRule(config, "agent/missing-index", "warning", bundle.indexes.length === 0 ? [{
      code: "agent/missing-index",
      severity: "warning",
      message: "Bundle should include index.md so humans and agents have a navigable entrypoint."
    }] : []),
    ...configuredDoctorRule(config, "agent/stale-timestamp", "warning", staleTimestampDiagnostics(bundle, now)),
    ...configuredDoctorRule(
      config,
      "agent/deprecated-missing-replacement",
      "warning",
      deprecatedMissingReplacementDiagnostics(bundle)
    )
  ];
}

function configuredDoctorRule(
  config: ResolvedOkfxConfig,
  id: string,
  defaultSeverity: DiagnosticSeverity,
  diagnostics: DiagnosticIR[]
): DiagnosticIR[] {
  const configuredLevel = Object.hasOwn(config.rules, id) ? config.rules[id] : undefined;
  const severity = resolveRuleLevel(configuredLevel, defaultSeverity);
  return severity === "off" ? [] : diagnostics.map((diagnostic) => ({ ...diagnostic, severity }));
}

function readinessScore(counts: DiagnosticCounts): number {
  return Math.max(0, 100 - counts.error * 20 - counts.warning * 8 - counts.advice * 3);
}
