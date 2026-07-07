use okfx_resolver::ResolvedLink;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const CRATE_NAME: &str = "okfx_graph";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConceptNodeInput {
    pub id: String,
    pub path: String,
    pub concept_type: String,
    pub title: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub path: String,
    pub node_type: String,
    pub title: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub resolved: bool,
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphStats {
    pub node_count: usize,
    pub edge_count: usize,
    pub orphan_count: usize,
    pub broken_link_count: usize,
    pub cycle_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopReferencedConcept {
    pub id: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphAnalysis {
    pub backlinks: BTreeMap<String, Vec<String>>,
    pub broken_links: Vec<GraphEdge>,
    pub orphan_concept_ids: Vec<String>,
    pub isolated_cluster_count: usize,
    pub cycles: Vec<Vec<String>>,
    pub top_referenced_concepts: Vec<TopReferencedConcept>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub stats: GraphStats,
    pub analysis: GraphAnalysis,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn build_graph(concepts: Vec<ConceptNodeInput>, links: Vec<ResolvedLink>) -> Graph {
    let nodes = concepts
        .iter()
        .map(|concept| GraphNode {
            id: concept.id.clone(),
            path: concept.path.clone(),
            node_type: concept.concept_type.clone(),
            title: concept.title.clone(),
            tags: concept.tags.clone(),
        })
        .collect::<Vec<_>>();
    let concept_ids = concepts
        .iter()
        .map(|concept| concept.id.clone())
        .collect::<BTreeSet<_>>();
    let edges = links
        .into_iter()
        .filter(|link| matches!(link.kind, okfx_parser::LinkKind::Internal))
        .map(|link| GraphEdge {
            source: link.source_concept_id,
            target: link.target_concept_id.unwrap_or(link.target_raw),
            kind: "markdown-link".to_string(),
            resolved: link.resolved,
            label: link.text,
        })
        .collect::<Vec<_>>();
    let analysis = analyze_graph(&concept_ids, &edges);
    let stats = GraphStats {
        node_count: nodes.len(),
        edge_count: edges.len(),
        orphan_count: analysis.orphan_concept_ids.len(),
        broken_link_count: analysis.broken_links.len(),
        cycle_count: analysis.cycles.len(),
    };

    Graph {
        nodes,
        edges,
        stats,
        analysis,
    }
}

fn analyze_graph(concept_ids: &BTreeSet<String>, edges: &[GraphEdge]) -> GraphAnalysis {
    let mut incoming: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut outgoing: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut broken_links = Vec::new();

    for edge in edges {
        if !edge.resolved {
            broken_links.push(edge.clone());
            continue;
        }

        if !concept_ids.contains(&edge.target) {
            continue;
        }

        incoming
            .entry(edge.target.clone())
            .or_default()
            .insert(edge.source.clone());
        if concept_ids.contains(&edge.source) {
            outgoing
                .entry(edge.source.clone())
                .or_default()
                .insert(edge.target.clone());
        }
    }

    let backlinks = concept_ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                incoming
                    .get(id)
                    .map(|sources| sources.iter().cloned().collect())
                    .unwrap_or_default(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let orphan_concept_ids = concept_ids
        .iter()
        .filter(|id| incoming.get(*id).is_none_or(BTreeSet::is_empty))
        .filter(|id| outgoing.get(*id).is_none_or(BTreeSet::is_empty))
        .cloned()
        .collect::<Vec<_>>();
    let cycles = find_cycles(concept_ids, &outgoing);
    let top_referenced_concepts = incoming
        .iter()
        .map(|(id, sources)| TopReferencedConcept {
            id: id.clone(),
            count: sources.len(),
        })
        .collect::<Vec<_>>();

    GraphAnalysis {
        backlinks,
        broken_links,
        orphan_concept_ids,
        isolated_cluster_count: count_isolated_clusters(concept_ids, &incoming, &outgoing),
        cycles,
        top_referenced_concepts,
    }
}

fn find_cycles(
    concept_ids: &BTreeSet<String>,
    outgoing: &BTreeMap<String, BTreeSet<String>>,
) -> Vec<Vec<String>> {
    let mut cycles: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for id in concept_ids {
        visit_cycle(id, outgoing, &mut Vec::new(), &mut cycles);
    }

    cycles.into_values().collect()
}

fn visit_cycle(
    id: &str,
    outgoing: &BTreeMap<String, BTreeSet<String>>,
    stack: &mut Vec<String>,
    cycles: &mut BTreeMap<String, Vec<String>>,
) {
    if let Some(position) = stack.iter().position(|entry| entry == id) {
        let mut cycle = stack[position..].to_vec();
        cycle.push(id.to_string());
        let mut key_parts = cycle.clone();
        key_parts.sort();
        key_parts.dedup();
        cycles.entry(key_parts.join(">")).or_insert(cycle);
        return;
    }

    stack.push(id.to_string());
    if let Some(next_ids) = outgoing.get(id) {
        for next in next_ids {
            visit_cycle(next, outgoing, stack, cycles);
        }
    }
    stack.pop();
}

fn count_isolated_clusters(
    concept_ids: &BTreeSet<String>,
    incoming: &BTreeMap<String, BTreeSet<String>>,
    outgoing: &BTreeMap<String, BTreeSet<String>>,
) -> usize {
    let mut visited = BTreeSet::new();
    let mut clusters = 0;

    for id in concept_ids {
        if visited.contains(id) {
            continue;
        }

        clusters += 1;
        let mut queue = vec![id.clone()];
        while let Some(current) = queue.pop() {
            if !visited.insert(current.clone()) {
                continue;
            }
            if let Some(next_ids) = outgoing.get(&current) {
                queue.extend(next_ids.iter().cloned());
            }
            if let Some(next_ids) = incoming.get(&current) {
                queue.extend(next_ids.iter().cloned());
            }
        }
    }

    clusters
}

#[cfg(test)]
mod tests {
    use super::*;
    use okfx_parser::parse_markdown_document;
    use okfx_resolver::{resolve_links, LinkEntry};

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_graph");
    }

    #[test]
    fn builds_graph_analysis() {
        let a = parse_markdown_document("a.md", "---\ntype: Note\n---\n[B](b.md)\n[Missing](missing.md)\n", "a");
        let b = parse_markdown_document("b.md", "---\ntype: Note\n---\n[A](a.md)\n", "b");
        let resolved = resolve_links(
            a.links
                .into_iter()
                .map(|link| LinkEntry {
                    source_path: "a.md".to_string(),
                    link,
                })
                .chain(b.links.into_iter().map(|link| LinkEntry {
                    source_path: "b.md".to_string(),
                    link,
                }))
                .collect(),
            ["a".to_string(), "b".to_string(), "orphan".to_string()],
        );
        let graph = build_graph(
            vec![
                concept("a"),
                concept("b"),
                concept("orphan"),
            ],
            resolved.links,
        );

        assert_eq!(graph.stats.node_count, 3);
        assert_eq!(graph.stats.edge_count, 3);
        assert_eq!(graph.stats.broken_link_count, 1);
        assert_eq!(graph.stats.orphan_count, 1);
        assert_eq!(graph.analysis.orphan_concept_ids, vec!["orphan"]);
        assert_eq!(graph.analysis.backlinks["a"], vec!["b"]);
        assert_eq!(graph.analysis.backlinks["b"], vec!["a"]);
        assert_eq!(graph.stats.cycle_count, 1);
    }

    fn concept(id: &str) -> ConceptNodeInput {
        ConceptNodeInput {
            id: id.to_string(),
            path: format!("{id}.md"),
            concept_type: "Note".to_string(),
            title: Some(id.to_string()),
            tags: Vec::new(),
        }
    }
}
