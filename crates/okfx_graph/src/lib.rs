use okfx_core::find_representative_cycles;
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
    #[serde(default)]
    pub resource: Vec<String>,
    #[serde(default)]
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
    let mut edges = links
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
    for concept in &concepts {
        edges.extend(metadata_edges(concept));
    }
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

fn metadata_edges(concept: &ConceptNodeInput) -> Vec<GraphEdge> {
    unique_non_empty(&concept.resource)
        .into_iter()
        .map(|resource| GraphEdge {
            source: concept.id.clone(),
            target: format!("resource:{resource}"),
            kind: "resource".to_string(),
            resolved: true,
            label: Some(resource),
        })
        .chain(
            unique_non_empty(&concept.tags)
                .into_iter()
                .map(|tag| GraphEdge {
                    source: concept.id.clone(),
                    target: format!("tag:{tag}"),
                    kind: "tag".to_string(),
                    resolved: true,
                    label: Some(tag),
                }),
        )
        .collect()
}

fn unique_non_empty(values: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();

    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        result.push(trimmed.to_string());
    }

    result
}

fn analyze_graph(concept_ids: &BTreeSet<String>, edges: &[GraphEdge]) -> GraphAnalysis {
    let mut incoming: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut outgoing: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut broken_links = Vec::new();

    for edge in edges {
        if edge.kind != "markdown-link" {
            continue;
        }
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
    let cycles = find_representative_cycles(concept_ids, &outgoing);
    let mut top_referenced_concepts = incoming
        .iter()
        .map(|(id, sources)| TopReferencedConcept {
            id: id.clone(),
            count: sources.len(),
        })
        .collect::<Vec<_>>();
    top_referenced_concepts.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.id.cmp(&right.id))
    });
    top_referenced_concepts.truncate(10);

    GraphAnalysis {
        backlinks,
        broken_links,
        orphan_concept_ids,
        isolated_cluster_count: count_isolated_clusters(concept_ids, &incoming, &outgoing),
        cycles,
        top_referenced_concepts,
    }
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
    use okfx_resolver::{LinkEntry, resolve_links};

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_graph");
    }

    #[test]
    fn builds_graph_analysis() {
        let a = parse_markdown_document(
            "a.md",
            "---\ntype: Note\n---\n[B](b.md)\n[Missing](missing.md)\n",
            "a",
        );
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
            vec![concept("a"), concept("b"), concept("orphan")],
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

    #[test]
    fn includes_resource_and_tag_edges() {
        let graph = build_graph(
            vec![ConceptNodeInput {
                id: "a".to_string(),
                path: "a.md".to_string(),
                concept_type: "Note".to_string(),
                title: Some("A".to_string()),
                resource: vec![
                    "https://docs.example.com/a".to_string(),
                    "bigquery://project/dataset/table".to_string(),
                    "https://docs.example.com/a".to_string(),
                ],
                tags: vec![
                    "analytics".to_string(),
                    "trusted".to_string(),
                    "analytics".to_string(),
                ],
            }],
            Vec::new(),
        );

        let edges = graph
            .edges
            .iter()
            .map(|edge| {
                (
                    edge.kind.as_str(),
                    edge.target.as_str(),
                    edge.label.as_deref(),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(graph.stats.edge_count, 4);
        assert_eq!(graph.stats.orphan_count, 1);
        assert_eq!(
            edges,
            vec![
                (
                    "resource",
                    "resource:https://docs.example.com/a",
                    Some("https://docs.example.com/a")
                ),
                (
                    "resource",
                    "resource:bigquery://project/dataset/table",
                    Some("bigquery://project/dataset/table")
                ),
                ("tag", "tag:analytics", Some("analytics")),
                ("tag", "tag:trusted", Some("trusted")),
            ]
        );
        assert!(graph.analysis.backlinks["a"].is_empty());
    }

    #[test]
    fn does_not_treat_metadata_target_collisions_as_concept_links() {
        let mut source = concept("source");
        source.tags = vec!["analytics".to_string()];

        let graph = build_graph(vec![source, concept("tag:analytics")], Vec::new());

        assert!(graph.edges.iter().any(|edge| {
            edge.kind == "tag" && edge.source == "source" && edge.target == "tag:analytics"
        }));
        assert!(graph.analysis.backlinks["tag:analytics"].is_empty());
        assert_eq!(
            graph.analysis.orphan_concept_ids,
            vec!["source", "tag:analytics"]
        );
        assert_eq!(graph.analysis.isolated_cluster_count, 2);
    }

    #[test]
    fn ranks_and_limits_top_referenced_concepts() {
        let concepts = (0..12)
            .map(|index| concept(&format!("target-{index:02}")))
            .collect::<Vec<_>>();
        let mut links = (0..12)
            .map(|index| {
                resolved_link(&format!("source-{index:02}"), &format!("target-{index:02}"))
            })
            .collect::<Vec<_>>();
        links.push(resolved_link("extra-source", "target-11"));

        let graph = build_graph(concepts, links);

        assert_eq!(graph.analysis.top_referenced_concepts.len(), 10);
        assert_eq!(
            graph.analysis.top_referenced_concepts[0],
            TopReferencedConcept {
                id: "target-11".to_string(),
                count: 2
            }
        );
        assert_eq!(graph.analysis.top_referenced_concepts[1].id, "target-00");
    }

    #[test]
    fn analyzes_dense_acyclic_graphs_without_enumerating_paths() {
        let node_count = 40;
        let concept_ids = (0..node_count)
            .map(|index| format!("node-{index}"))
            .collect::<BTreeSet<_>>();
        let outgoing = (0..node_count)
            .map(|source| {
                let targets = (source + 1..node_count)
                    .map(|target| format!("node-{target}"))
                    .collect::<BTreeSet<_>>();
                (format!("node-{source}"), targets)
            })
            .collect::<BTreeMap<_, _>>();

        assert!(find_representative_cycles(&concept_ids, &outgoing).is_empty());
    }

    fn concept(id: &str) -> ConceptNodeInput {
        ConceptNodeInput {
            id: id.to_string(),
            path: format!("{id}.md"),
            concept_type: "Note".to_string(),
            title: Some(id.to_string()),
            resource: Vec::new(),
            tags: Vec::new(),
        }
    }

    fn resolved_link(source: &str, target: &str) -> ResolvedLink {
        ResolvedLink {
            source_concept_id: source.to_string(),
            source_path: format!("{source}.md"),
            target_raw: format!("{target}.md"),
            target_concept_id: Some(target.to_string()),
            text: None,
            kind: okfx_parser::LinkKind::Internal,
            resolved: true,
        }
    }
}
