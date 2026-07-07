import type { BundleIR, DiagnosticIR, OkfxGraphIR, ResolvedOkfxConfig } from "@okfx/core";

export interface OkfxRuleContext {
  bundle: BundleIR;
  config: ResolvedOkfxConfig;
  plugin?: {
    name: string;
    source?: string;
    version?: string;
  };
  options?: Record<string, unknown>;
}

export interface OkfxRule {
  meta: {
    description: string;
    defaultSeverity?: DiagnosticIR["severity"];
    severity?: DiagnosticIR["severity"];
  };
  run(context: OkfxRuleContext): DiagnosticIR[] | Promise<DiagnosticIR[]>;
}

export interface OkfxAdapterContext {
  root: string;
  config: ResolvedOkfxConfig;
}

export interface OkfxProducerAdapter {
  produce(context: OkfxAdapterContext): Promise<Array<{ path: string; content: string }>>;
}

export interface OkfxConsumerAdapter {
  consume(context: OkfxAdapterContext & { bundle: BundleIR; graph?: OkfxGraphIR }): Promise<Array<{ path: string; content: string }> | void>;
}

export interface OkfxPlugin {
  name: string;
  version?: string;
  rules?: Record<string, OkfxRule>;
  adapters?: Record<string, OkfxProducerAdapter | OkfxConsumerAdapter>;
  mcpTools?: Record<string, unknown>;
}

export function definePlugin<TPlugin extends OkfxPlugin>(plugin: TPlugin): TPlugin {
  return plugin;
}
