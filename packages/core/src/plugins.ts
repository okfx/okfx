import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createJiti } from "jiti";

import type { BundleIR, DiagnosticIR, DiagnosticSeverity } from "./types.js";
import type { ResolvedOkfxConfig, ResolvedOkfxPluginReference } from "./config.js";

export interface OkfxPluginRuleContext {
  bundle: BundleIR;
  config: ResolvedOkfxConfig;
  plugin: LoadedOkfxPlugin;
  options: Record<string, unknown>;
}

export interface OkfxRuntimeRule {
  meta?: {
    description?: string;
    defaultSeverity?: DiagnosticSeverity;
    severity?: DiagnosticSeverity;
  };
  run(context: OkfxPluginRuleContext): DiagnosticIR[] | Promise<DiagnosticIR[]>;
}

export interface OkfxRuntimePlugin {
  name: string;
  version?: string;
  rules?: Record<string, OkfxRuntimeRule>;
  adapters?: Record<string, unknown>;
  mcpTools?: Record<string, unknown>;
}

export interface LoadedOkfxPlugin {
  name: string;
  source: string;
  version?: string;
  options: Record<string, unknown>;
  rules: Record<string, OkfxRuntimeRule>;
}

export interface PluginLoadResult {
  plugins: LoadedOkfxPlugin[];
  diagnostics: DiagnosticIR[];
}

export interface PluginLoadOptions {
  enabled?: boolean;
}

export async function loadConfiguredPlugins(
  root: string,
  config: ResolvedOkfxConfig,
  options: PluginLoadOptions = {}
): Promise<PluginLoadResult> {
  if (options.enabled === false || config.plugins.length === 0) {
    return {
      plugins: [],
      diagnostics: []
    };
  }

  const jiti = createJiti(pathToFileURL(config.configPath ?? resolve(root, "okfx.config.ts")).href, {
    interopDefault: true,
    moduleCache: false
  });
  const plugins: LoadedOkfxPlugin[] = [];
  const diagnostics: DiagnosticIR[] = [];

  for (const reference of config.plugins.filter((plugin) => plugin.enabled)) {
    try {
      const imported = await jiti.import<unknown>(reference.package, { default: true });
      const plugin = unwrapPlugin(imported);
      if (!plugin) {
        diagnostics.push(pluginDiagnostic("plugin/invalid-shape", reference, "Plugin module must export an object with a string name."));
        continue;
      }

      plugins.push({
        name: plugin.name,
        source: reference.package,
        version: plugin.version,
        options: reference.options,
        rules: normalizePluginRules(plugin.rules)
      });
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        "plugin/load-failed",
        reference,
        `Failed to load plugin "${reference.package}": ${error instanceof Error ? error.message : String(error)}`
      ));
    }
  }

  return {
    plugins,
    diagnostics
  };
}

function unwrapPlugin(imported: unknown): OkfxRuntimePlugin | undefined {
  const candidate = isRecord(imported) && "default" in imported
    ? imported.default
    : imported;

  if (!isRecord(candidate) || typeof candidate.name !== "string") {
    return undefined;
  }

  return candidate as unknown as OkfxRuntimePlugin;
}

function normalizePluginRules(rules: unknown): Record<string, OkfxRuntimeRule> {
  if (!isRecord(rules)) {
    return {};
  }

  const normalized = Object.create(null) as Record<string, OkfxRuntimeRule>;
  for (const [id, rule] of Object.entries(rules)) {
    if (isRecord(rule) && typeof rule.run === "function") {
      normalized[id] = rule as unknown as OkfxRuntimeRule;
    }
  }

  return normalized;
}

function pluginDiagnostic(
  code: string,
  reference: ResolvedOkfxPluginReference,
  message: string
): DiagnosticIR {
  return {
    code,
    severity: "error",
    message,
    path: reference.package
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
