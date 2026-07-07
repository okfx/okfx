export type DiagnosticSeverity = "error" | "warning" | "advice" | "info";
export type LinkKind = "internal" | "external" | "anchor" | "unknown";

export interface SourceLocationIR {
  line: number;
  column: number;
  offset?: number;
}

export interface SourceRangeIR {
  start: SourceLocationIR;
  end?: SourceLocationIR;
}

export interface FixIR {
  description: string;
  replacement?: string;
}

export interface DiagnosticIR {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
  conceptId?: string;
  location?: SourceRangeIR;
  fix?: FixIR;
  docsUrl?: string;
}

export interface HeadingIR {
  level: number;
  title: string;
  slug: string;
  location: SourceRangeIR;
}

export interface MarkdownBodyIR {
  raw: string;
  text: string;
  headings: HeadingIR[];
}

export interface LinkIR {
  sourceConceptId: string;
  targetRaw: string;
  targetConceptId?: string;
  text?: string;
  kind: LinkKind;
  resolved: boolean;
  location: SourceRangeIR;
}

export interface ConceptIR {
  id: string;
  path: string;
  type: string;
  title?: string;
  description?: string;
  resource?: string | string[];
  tags?: string[];
  timestamp?: string;
  frontmatter: Record<string, unknown>;
  body: MarkdownBodyIR;
  links: LinkIR[];
  contentHash: string;
}

export interface IndexFileIR {
  path: string;
  body: MarkdownBodyIR;
  links: LinkIR[];
  contentHash: string;
}

export interface LogFileIR {
  path: string;
  body: MarkdownBodyIR;
  links: LinkIR[];
  contentHash: string;
}

export interface BundleStatsIR {
  fileCount: number;
  conceptCount: number;
  indexCount: number;
  logCount: number;
  linkCount: number;
  brokenLinkCount: number;
  diagnosticCount: number;
}

export interface BundleIR {
  root: string;
  okfVersion?: string;
  concepts: ConceptIR[];
  indexes: IndexFileIR[];
  logs: LogFileIR[];
  links: LinkIR[];
  diagnostics: DiagnosticIR[];
  stats: BundleStatsIR;
}

export interface GraphNodeIR {
  id: string;
  path: string;
  type: string;
  title?: string;
  tags?: string[];
}

export interface GraphEdgeIR {
  source: string;
  target: string;
  kind: "markdown-link" | "resource" | "tag" | "custom";
  resolved: boolean;
  label?: string;
}

export interface GraphIR {
  nodes: GraphNodeIR[];
  edges: GraphEdgeIR[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    orphanCount: number;
    brokenLinkCount: number;
    cycleCount: number;
  };
}
