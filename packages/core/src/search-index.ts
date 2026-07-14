import { compareStrings } from "./compare.js";
import { buildGraph } from "./graph.js";
import type { BundleIR } from "./types.js";

export interface SearchIndexDocumentIR {
  id: string;
  path: string;
  type: string;
  title?: string;
  description?: string;
  tags: string[];
  headings: string[];
  body: string;
  backlinks: string[];
}

export interface SearchIndexIR {
  schema_version: 1;
  mode: "full-text";
  generated_from: {
    okf_version?: string;
    concept_count: number;
  };
  documents: SearchIndexDocumentIR[];
  terms: Record<string, string[]>;
}

export function buildSearchIndex(bundle: BundleIR): SearchIndexIR {
  const graph = buildGraph(bundle);
  const documents = bundle.concepts.map((concept) => ({
    id: concept.id,
    path: concept.path,
    type: concept.type,
    title: concept.title,
    description: concept.description,
    tags: concept.tags ?? [],
    headings: concept.body.headings.map((heading) => heading.title),
    body: concept.body.text,
    backlinks: graph.analysis.backlinks[concept.id] ?? []
  })).sort((a, b) => compareStrings(a.id, b.id));
  const terms = buildTermMap(documents);

  return {
    schema_version: 1,
    mode: "full-text",
    generated_from: {
      okf_version: bundle.okfVersion,
      concept_count: bundle.stats.conceptCount
    },
    documents,
    terms
  };
}

function buildTermMap(documents: SearchIndexDocumentIR[]): Record<string, string[]> {
  const idsByTerm = new Map<string, Set<string>>();

  for (const document of documents) {
    for (const term of tokenizeSearchText([
      document.id,
      document.title,
      document.description,
      document.type,
      ...document.tags,
      ...document.headings,
      document.body
    ].filter((value): value is string => Boolean(value)).join(" "))) {
      const ids = idsByTerm.get(term) ?? new Set<string>();
      ids.add(document.id);
      idsByTerm.set(term, ids);
    }
  }

  return Object.fromEntries([...idsByTerm.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([term, ids]) => [term, [...ids].sort(compareStrings)]));
}

export function tokenizeSearchText(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => [...term].length >= 2))];
}
