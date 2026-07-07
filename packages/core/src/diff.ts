import type { BundleIR, ConceptIR } from "./types.js";

export interface ConceptRenameIR {
  from: string;
  to: string;
  contentHash: string;
}

export interface ConceptChangeIR {
  id: string;
  path: string;
  changes: string[];
  frontmatterChanged: string[];
  linksAdded: string[];
  linksRemoved: string[];
  bodyChanged: boolean;
  resourceChanged: boolean;
  tagsChanged: boolean;
}

export interface BundleDiffIR {
  addedConcepts: string[];
  removedConcepts: string[];
  renamedConcepts: ConceptRenameIR[];
  changedConcepts: ConceptChangeIR[];
  stats: {
    addedCount: number;
    removedCount: number;
    renamedCount: number;
    changedCount: number;
  };
}

export function diffBundles(before: BundleIR, after: BundleIR): BundleDiffIR {
  const beforeById = new Map(before.concepts.map((concept) => [concept.id, concept]));
  const afterById = new Map(after.concepts.map((concept) => [concept.id, concept]));
  const added = after.concepts.filter((concept) => !beforeById.has(concept.id));
  const removed = before.concepts.filter((concept) => !afterById.has(concept.id));
  const renamed = detectRenames(removed, added);
  const renamedFrom = new Set(renamed.map((entry) => entry.from));
  const renamedTo = new Set(renamed.map((entry) => entry.to));
  const addedConcepts = added.map((concept) => concept.id).filter((id) => !renamedTo.has(id)).sort();
  const removedConcepts = removed.map((concept) => concept.id).filter((id) => !renamedFrom.has(id)).sort();
  const changedConcepts = [...afterById.entries()]
    .filter(([id]) => beforeById.has(id))
    .map(([id, afterConcept]) => changedConcept(beforeById.get(id)!, afterConcept))
    .filter((change): change is ConceptChangeIR => change !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    addedConcepts,
    removedConcepts,
    renamedConcepts: renamed,
    changedConcepts,
    stats: {
      addedCount: addedConcepts.length,
      removedCount: removedConcepts.length,
      renamedCount: renamed.length,
      changedCount: changedConcepts.length
    }
  };
}

function detectRenames(removed: ConceptIR[], added: ConceptIR[]): ConceptRenameIR[] {
  const addedByHash = new Map<string, ConceptIR[]>();
  for (const concept of added) {
    addedByHash.set(concept.contentHash, [...(addedByHash.get(concept.contentHash) ?? []), concept]);
  }

  const renames: ConceptRenameIR[] = [];
  for (const concept of removed) {
    const candidates = addedByHash.get(concept.contentHash) ?? [];
    const candidate = candidates.shift();
    if (!candidate) {
      continue;
    }
    renames.push({
      from: concept.id,
      to: candidate.id,
      contentHash: concept.contentHash
    });
  }

  return renames.sort((a, b) => a.from.localeCompare(b.from));
}

function changedConcept(before: ConceptIR, after: ConceptIR): ConceptChangeIR | undefined {
  const frontmatterChanged = changedFrontmatterKeys(before, after);
  const beforeLinks = linkSet(before);
  const afterLinks = linkSet(after);
  const linksAdded = [...afterLinks].filter((link) => !beforeLinks.has(link)).sort();
  const linksRemoved = [...beforeLinks].filter((link) => !afterLinks.has(link)).sort();
  const bodyChanged = before.body.raw !== after.body.raw;
  const resourceChanged = !stableEqual(before.resource, after.resource);
  const tagsChanged = !stableEqual(before.tags, after.tags);
  const changes = [
    ...frontmatterChanged.map((key) => `frontmatter.${key} changed`),
    ...(bodyChanged ? ["body changed"] : []),
    ...linksAdded.map((link) => `link added: ${link}`),
    ...linksRemoved.map((link) => `link removed: ${link}`)
  ];

  if (changes.length === 0) {
    return undefined;
  }

  return {
    id: after.id,
    path: after.path,
    changes,
    frontmatterChanged,
    linksAdded,
    linksRemoved,
    bodyChanged,
    resourceChanged,
    tagsChanged
  };
}

function changedFrontmatterKeys(before: ConceptIR, after: ConceptIR): string[] {
  const keys = new Set([...Object.keys(before.frontmatter), ...Object.keys(after.frontmatter)]);
  return [...keys]
    .filter((key) => !stableEqual(before.frontmatter[key], after.frontmatter[key]))
    .sort();
}

function linkSet(concept: ConceptIR): Set<string> {
  return new Set(concept.links.map((link) => link.targetConceptId ?? link.targetRaw));
}

function stableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
