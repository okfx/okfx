use okfx_resolver::ResolvedLink;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

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
    let mut reverse = concept_ids
        .iter()
        .map(|id| (id.clone(), BTreeSet::new()))
        .collect::<BTreeMap<_, _>>();
    for (source, targets) in outgoing {
        if !concept_ids.contains(source) {
            continue;
        }
        for target in targets
            .iter()
            .filter(|target| concept_ids.contains(*target))
        {
            reverse
                .entry(target.clone())
                .or_default()
                .insert(source.clone());
        }
    }

    let mut finish_order = Vec::new();
    let mut visited = BTreeSet::new();
    for start in concept_ids {
        if visited.contains(start) {
            continue;
        }
        let mut stack = vec![(start.clone(), false)];
        while let Some((current, expanded)) = stack.pop() {
            if expanded {
                finish_order.push(current);
                continue;
            }
            if !visited.insert(current.clone()) {
                continue;
            }
            stack.push((current.clone(), true));
            if let Some(neighbors) = outgoing.get(&current) {
                for neighbor in neighbors.iter().rev() {
                    if concept_ids.contains(neighbor) && !visited.contains(neighbor) {
                        stack.push((neighbor.clone(), false));
                    }
                }
            }
        }
    }

    let mut assigned = BTreeSet::new();
    let mut components = Vec::new();
    for start in finish_order.into_iter().rev() {
        if !assigned.insert(start.clone()) {
            continue;
        }
        let mut component = Vec::new();
        let mut stack = vec![start];
        while let Some(current) = stack.pop() {
            component.push(current.clone());
            if let Some(neighbors) = reverse.get(&current) {
                for neighbor in neighbors.iter().rev() {
                    if assigned.insert(neighbor.clone()) {
                        stack.push(neighbor.clone());
                    }
                }
            }
        }
        component.sort();
        components.push(component);
    }

    let mut cycles = components
        .into_iter()
        .filter(|component| {
            component.len() > 1
                || outgoing
                    .get(&component[0])
                    .is_some_and(|targets| targets.contains(&component[0]))
        })
        .map(|component| representative_cycle(&component, outgoing))
        .collect::<Vec<_>>();
    cycles.sort();
    cycles
}

fn representative_cycle(
    component: &[String],
    outgoing: &BTreeMap<String, BTreeSet<String>>,
) -> Vec<String> {
    let start = &component[0];
    if component.len() == 1 {
        return vec![start.clone(), start.clone()];
    }

    let members = component.iter().collect::<BTreeSet<_>>();
    if let Some(first_steps) = outgoing.get(start) {
        for first_step in first_steps
            .iter()
            .filter(|next| *next != start && members.contains(next))
        {
            if let Some(path) = find_path(first_step, start, &members, outgoing) {
                return std::iter::once(start.clone()).chain(path).collect();
            }
        }
    }

    unreachable!("strongly connected component must contain a representative cycle")
}

fn find_path(
    from: &str,
    to: &str,
    members: &BTreeSet<&String>,
    outgoing: &BTreeMap<String, BTreeSet<String>>,
) -> Option<Vec<String>> {
    let mut parents = BTreeMap::from([(from.to_string(), None::<String>)]);
    let mut queue = VecDeque::from([from.to_string()]);

    while let Some(current) = queue.pop_front() {
        if current == to {
            let mut path = Vec::new();
            let mut cursor = Some(current);
            while let Some(id) = cursor {
                cursor = parents.get(&id).cloned().flatten();
                path.push(id);
            }
            path.reverse();
            return Some(path);
        }

        if let Some(neighbors) = outgoing.get(&current) {
            for neighbor in neighbors {
                if members.contains(neighbor) && !parents.contains_key(neighbor) {
                    parents.insert(neighbor.clone(), Some(current.clone()));
                    queue.push_back(neighbor.clone());
                }
            }
        }
    }

    None
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

        assert!(find_cycles(&concept_ids, &outgoing).is_empty());
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
}
