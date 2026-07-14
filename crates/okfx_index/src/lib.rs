use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const CRATE_NAME: &str = "okfx_index";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexDocumentInput {
    pub id: String,
    pub path: String,
    pub concept_type: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub headings: Vec<String>,
    pub body: String,
    pub backlinks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchIndexDocument {
    pub id: String,
    pub path: String,
    #[serde(rename = "type")]
    pub concept_type: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub headings: Vec<String>,
    pub body: String,
    pub backlinks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratedFrom {
    pub okf_version: Option<String>,
    pub concept_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchIndex {
    pub schema_version: u8,
    pub mode: String,
    pub generated_from: GeneratedFrom,
    pub documents: Vec<SearchIndexDocument>,
    pub terms: BTreeMap<String, Vec<String>>,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn build_search_index(
    okf_version: Option<String>,
    documents: Vec<IndexDocumentInput>,
) -> SearchIndex {
    let mut documents = documents
        .into_iter()
        .map(|document| SearchIndexDocument {
            id: document.id,
            path: document.path,
            concept_type: document.concept_type,
            title: document.title,
            description: document.description,
            tags: document.tags,
            headings: document.headings,
            body: document.body,
            backlinks: document.backlinks,
        })
        .collect::<Vec<_>>();
    documents.sort_by(|left, right| left.id.cmp(&right.id));
    let terms = build_term_map(&documents);
    let concept_count = documents.len();

    SearchIndex {
        schema_version: 1,
        mode: "full-text".to_string(),
        generated_from: GeneratedFrom {
            okf_version,
            concept_count,
        },
        documents,
        terms,
    }
}

fn build_term_map(documents: &[SearchIndexDocument]) -> BTreeMap<String, Vec<String>> {
    let mut ids_by_term = BTreeMap::<String, BTreeSet<String>>::new();

    for document in documents {
        let text = [
            vec![
                document.id.clone(),
                document.concept_type.clone(),
                document.title.clone().unwrap_or_default(),
                document.description.clone().unwrap_or_default(),
                document.body.clone(),
            ],
            document.tags.clone(),
            document.headings.clone(),
        ]
        .concat()
        .join(" ");
        for term in tokenize(&text) {
            ids_by_term
                .entry(term)
                .or_default()
                .insert(document.id.clone());
        }
    }

    ids_by_term
        .into_iter()
        .map(|(term, ids)| (term, ids.into_iter().collect()))
        .collect()
}

pub fn tokenize(value: &str) -> Vec<String> {
    let mut terms = BTreeSet::new();
    let mut current = String::new();

    for character in value.to_lowercase().chars() {
        if character.is_alphanumeric() || matches!(character, '_' | '-') {
            current.push(character);
        } else if current.chars().count() >= 2 {
            terms.insert(std::mem::take(&mut current));
        } else {
            current.clear();
        }
    }
    if current.chars().count() >= 2 {
        terms.insert(current);
    }

    terms.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_index");
    }

    #[test]
    fn builds_deterministic_full_text_index() {
        let index = build_search_index(
            Some("0.1".to_string()),
            vec![IndexDocumentInput {
                id: "metrics/wau".to_string(),
                path: "metrics/wau.md".to_string(),
                concept_type: "Metric".to_string(),
                title: Some("Weekly Active Users".to_string()),
                description: Some("Demo metric".to_string()),
                tags: vec!["analytics".to_string()],
                headings: vec!["Usage".to_string()],
                body: "Counts active users".to_string(),
                backlinks: vec!["index".to_string()],
            }],
        );

        assert_eq!(index.schema_version, 1);
        assert_eq!(index.mode, "full-text");
        assert_eq!(index.generated_from.okf_version.as_deref(), Some("0.1"));
        assert_eq!(index.generated_from.concept_count, 1);
        assert_eq!(index.documents[0].id, "metrics/wau");
        assert_eq!(index.terms["weekly"], vec!["metrics/wau"]);
        assert_eq!(index.terms["analytics"], vec!["metrics/wau"]);
        assert!(!index.terms.contains_key("index"));
        assert_eq!(
            tokenize("A weekly-active user's metric"),
            vec!["metric", "user", "weekly-active"]
        );
        assert_eq!(tokenize("中 中国 𐐀 𐐀𐐁"), vec!["中国", "𐐨𐐩"]);
    }
}
