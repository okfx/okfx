use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const CRATE_NAME: &str = "okfx_diff";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConceptSnapshot {
    pub id: String,
    pub path: String,
    pub content_hash: String,
    pub frontmatter: BTreeMap<String, String>,
    pub body: String,
    pub links: Vec<String>,
    pub resource: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConceptRename {
    pub from: String,
    pub to: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConceptChange {
    pub id: String,
    pub path: String,
    pub changes: Vec<String>,
    pub frontmatter_changed: Vec<String>,
    pub links_added: Vec<String>,
    pub links_removed: Vec<String>,
    pub body_changed: bool,
    pub resource_changed: bool,
    pub tags_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleDiffStats {
    pub added_count: usize,
    pub removed_count: usize,
    pub renamed_count: usize,
    pub changed_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleDiff {
    pub added_concepts: Vec<String>,
    pub removed_concepts: Vec<String>,
    pub renamed_concepts: Vec<ConceptRename>,
    pub changed_concepts: Vec<ConceptChange>,
    pub stats: BundleDiffStats,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn diff_concepts(before: Vec<ConceptSnapshot>, after: Vec<ConceptSnapshot>) -> BundleDiff {
    let before_by_id = before
        .iter()
        .map(|concept| (concept.id.clone(), concept.clone()))
        .collect::<BTreeMap<_, _>>();
    let after_by_id = after
        .iter()
        .map(|concept| (concept.id.clone(), concept.clone()))
        .collect::<BTreeMap<_, _>>();
    let added = after
        .iter()
        .filter(|concept| !before_by_id.contains_key(&concept.id))
        .cloned()
        .collect::<Vec<_>>();
    let removed = before
        .iter()
        .filter(|concept| !after_by_id.contains_key(&concept.id))
        .cloned()
        .collect::<Vec<_>>();
    let renamed_concepts = detect_renames(&removed, &added);
    let renamed_from = renamed_concepts
        .iter()
        .map(|rename| rename.from.clone())
        .collect::<BTreeSet<_>>();
    let renamed_to = renamed_concepts
        .iter()
        .map(|rename| rename.to.clone())
        .collect::<BTreeSet<_>>();
    let added_concepts = added
        .iter()
        .map(|concept| concept.id.clone())
        .filter(|id| !renamed_to.contains(id))
        .collect::<Vec<_>>();
    let removed_concepts = removed
        .iter()
        .map(|concept| concept.id.clone())
        .filter(|id| !renamed_from.contains(id))
        .collect::<Vec<_>>();
    let changed_concepts = after_by_id
        .iter()
        .filter_map(|(id, after_concept)| {
            before_by_id
                .get(id)
                .and_then(|before_concept| changed_concept(before_concept, after_concept))
        })
        .collect::<Vec<_>>();

    BundleDiff {
        stats: BundleDiffStats {
            added_count: added_concepts.len(),
            removed_count: removed_concepts.len(),
            renamed_count: renamed_concepts.len(),
            changed_count: changed_concepts.len(),
        },
        added_concepts,
        removed_concepts,
        renamed_concepts,
        changed_concepts,
    }
}

fn detect_renames(removed: &[ConceptSnapshot], added: &[ConceptSnapshot]) -> Vec<ConceptRename> {
    let mut added_by_hash = BTreeMap::<String, Vec<&ConceptSnapshot>>::new();
    for concept in added {
        added_by_hash
            .entry(concept.content_hash.clone())
            .or_default()
            .push(concept);
    }

    let mut renames = Vec::new();
    for concept in removed {
        let Some(candidates) = added_by_hash.get_mut(&concept.content_hash) else {
            continue;
        };
        if candidates.is_empty() {
            continue;
        }
        let candidate = candidates.remove(0);
        renames.push(ConceptRename {
            from: concept.id.clone(),
            to: candidate.id.clone(),
            content_hash: concept.content_hash.clone(),
        });
    }

    renames
}

fn changed_concept(before: &ConceptSnapshot, after: &ConceptSnapshot) -> Option<ConceptChange> {
    let frontmatter_changed = changed_frontmatter_keys(before, after);
    let before_links = before.links.iter().cloned().collect::<BTreeSet<_>>();
    let after_links = after.links.iter().cloned().collect::<BTreeSet<_>>();
    let links_added = after_links
        .difference(&before_links)
        .cloned()
        .collect::<Vec<_>>();
    let links_removed = before_links
        .difference(&after_links)
        .cloned()
        .collect::<Vec<_>>();
    let body_changed = before.body != after.body;
    let resource_changed = before.resource != after.resource;
    let tags_changed = before.tags != after.tags;

    let mut changes = frontmatter_changed
        .iter()
        .map(|key| format!("frontmatter.{key} changed"))
        .collect::<Vec<_>>();
    if body_changed {
        changes.push("body changed".to_string());
    }
    changes.extend(links_added.iter().map(|link| format!("link added: {link}")));
    changes.extend(links_removed.iter().map(|link| format!("link removed: {link}")));

    if changes.is_empty() {
        return None;
    }

    Some(ConceptChange {
        id: after.id.clone(),
        path: after.path.clone(),
        changes,
        frontmatter_changed,
        links_added,
        links_removed,
        body_changed,
        resource_changed,
        tags_changed,
    })
}

fn changed_frontmatter_keys(before: &ConceptSnapshot, after: &ConceptSnapshot) -> Vec<String> {
    before
        .frontmatter
        .keys()
        .chain(after.frontmatter.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|key| before.frontmatter.get(*key) != after.frontmatter.get(*key))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_diff");
    }

    #[test]
    fn reports_added_removed_renamed_and_changed_concepts() {
        let before = vec![
            concept("same", "hash-1").with_title("Old").with_body("old").with_link("old.md"),
            concept("removed", "hash-2"),
            concept("old-name", "hash-3"),
        ];
        let after = vec![
            concept("same", "hash-4").with_title("New").with_body("new").with_link("new.md"),
            concept("added", "hash-5"),
            concept("new-name", "hash-3"),
        ];

        let diff = diff_concepts(before, after);

        assert_eq!(diff.added_concepts, vec!["added"]);
        assert_eq!(diff.removed_concepts, vec!["removed"]);
        assert_eq!(diff.renamed_concepts[0].from, "old-name");
        assert_eq!(diff.renamed_concepts[0].to, "new-name");
        assert_eq!(diff.changed_concepts[0].id, "same");
        assert_eq!(diff.changed_concepts[0].frontmatter_changed, vec!["title"]);
        assert!(diff.changed_concepts[0].body_changed);
        assert_eq!(diff.changed_concepts[0].links_added, vec!["new.md"]);
        assert_eq!(diff.changed_concepts[0].links_removed, vec!["old.md"]);
    }

    fn concept(id: &str, hash: &str) -> ConceptSnapshot {
        ConceptSnapshot {
            id: id.to_string(),
            path: format!("{id}.md"),
            content_hash: hash.to_string(),
            frontmatter: BTreeMap::from([("title".to_string(), id.to_string())]),
            body: "# Body".to_string(),
            links: Vec::new(),
            resource: Vec::new(),
            tags: Vec::new(),
        }
    }

    trait ConceptBuilder {
        fn with_title(self, title: &str) -> Self;
        fn with_body(self, body: &str) -> Self;
        fn with_link(self, link: &str) -> Self;
    }

    impl ConceptBuilder for ConceptSnapshot {
        fn with_title(mut self, title: &str) -> Self {
            self.frontmatter.insert("title".to_string(), title.to_string());
            self
        }

        fn with_body(mut self, body: &str) -> Self {
            self.body = body.to_string();
            self
        }

        fn with_link(mut self, link: &str) -> Self {
            self.links.push(link.to_string());
            self
        }
    }
}
