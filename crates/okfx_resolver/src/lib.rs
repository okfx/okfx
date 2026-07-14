use okfx_parser::{Link, LinkKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

pub const CRATE_NAME: &str = "okfx_resolver";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkEntry {
    pub source_path: String,
    pub link: Link,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedLink {
    pub source_concept_id: String,
    pub source_path: String,
    pub target_raw: String,
    pub target_concept_id: Option<String>,
    pub text: Option<String>,
    pub kind: LinkKind,
    pub resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolutionResult {
    pub links: Vec<ResolvedLink>,
    pub backlinks: BTreeMap<String, Vec<String>>,
    pub broken_internal_links: Vec<ResolvedLink>,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn normalize_relative_path(path: impl AsRef<str>) -> Option<String> {
    let input = path.as_ref().replace('\\', "/");
    if input.starts_with('/') || input.contains('\0') {
        return None;
    }

    let mut parts = Vec::new();
    for component in Path::new(&input).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    Some(parts.join("/"))
}

pub fn concept_id_from_path(path: impl AsRef<str>) -> Option<String> {
    let normalized = normalize_relative_path(path)?;
    Some(
        normalized
            .strip_suffix(".md")
            .unwrap_or(&normalized)
            .to_string(),
    )
}

pub fn is_reserved_markdown_file(path: impl AsRef<str>) -> bool {
    path.as_ref()
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .is_some_and(|name| matches!(name, "index.md" | "log.md"))
}

pub fn resolve_markdown_target(
    source_path: impl AsRef<str>,
    target_raw: impl AsRef<str>,
) -> Option<String> {
    let target_raw = target_raw.as_ref();
    let unescaped_target = unescape_markdown_destination(target_raw);
    let target_without_hash = unescaped_target.split('#').next().unwrap_or("");
    let target_without_query = target_without_hash.split('?').next().unwrap_or("");
    if target_without_query.is_empty() {
        return None;
    }

    let decoded_target = decode_percent_runs(target_without_query);

    let target_path = if let Some(stripped) = decoded_target.strip_prefix('/') {
        stripped.to_string()
    } else {
        let source_path = normalize_relative_path(source_path)?;
        let source_dir = source_path
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("");
        if source_dir.is_empty() {
            decoded_target
        } else {
            format!("{source_dir}/{decoded_target}")
        }
    };

    concept_id_from_path(target_path)
}

fn unescape_markdown_destination(value: &str) -> String {
    let mut characters = value.chars().peekable();
    let mut unescaped = String::with_capacity(value.len());
    while let Some(character) = characters.next() {
        if character == '\\'
            && characters
                .peek()
                .is_some_and(|next| next.is_ascii_punctuation())
        {
            unescaped.push(characters.next().unwrap_or_default());
        } else {
            unescaped.push(character);
        }
    }
    unescaped
}

fn decode_percent_runs(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;

    while cursor < bytes.len() {
        if bytes[cursor] == b'%'
            && cursor + 2 < bytes.len()
            && hex_value(bytes[cursor + 1]).is_some()
            && hex_value(bytes[cursor + 2]).is_some()
        {
            let start = cursor;
            let mut decoded = Vec::new();
            while cursor + 2 < bytes.len() && bytes[cursor] == b'%' {
                let (Some(high), Some(low)) =
                    (hex_value(bytes[cursor + 1]), hex_value(bytes[cursor + 2]))
                else {
                    break;
                };
                decoded.push((high << 4) | low);
                cursor += 3;
            }
            if let Ok(decoded) = String::from_utf8(decoded) {
                output.push_str(&decoded);
            } else {
                output.push_str(&value[start..cursor]);
            }
            continue;
        }

        let character = value[cursor..].chars().next().unwrap_or_default();
        output.push(character);
        cursor += character.len_utf8();
    }

    output
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub fn resolve_links(
    entries: Vec<LinkEntry>,
    concept_ids: impl IntoIterator<Item = String>,
) -> ResolutionResult {
    let concept_ids: BTreeSet<String> = concept_ids.into_iter().collect();
    let mut links = Vec::new();
    let mut backlinks: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut broken_internal_links = Vec::new();

    for entry in entries {
        let target_concept_id = if entry.link.kind == LinkKind::Internal {
            resolve_markdown_target(&entry.source_path, &entry.link.target_raw)
        } else {
            None
        };
        let resolved = match entry.link.kind {
            LinkKind::Internal => target_concept_id
                .as_ref()
                .is_some_and(|target| concept_ids.contains(target)),
            LinkKind::External | LinkKind::Anchor => true,
            LinkKind::Unknown => false,
        };
        let resolved_link = ResolvedLink {
            source_concept_id: entry.link.source_concept_id.clone(),
            source_path: entry.source_path,
            target_raw: entry.link.target_raw,
            target_concept_id: if resolved { target_concept_id } else { None },
            text: entry.link.text,
            kind: entry.link.kind,
            resolved,
        };

        if resolved_link.kind == LinkKind::Internal && resolved_link.resolved {
            if let Some(target) = &resolved_link.target_concept_id {
                backlinks
                    .entry(target.clone())
                    .or_default()
                    .insert(resolved_link.source_concept_id.clone());
            }
        } else if resolved_link.kind == LinkKind::Internal {
            broken_internal_links.push(resolved_link.clone());
        }

        links.push(resolved_link);
    }

    ResolutionResult {
        links,
        backlinks: backlinks
            .into_iter()
            .map(|(target, sources)| (target, sources.into_iter().collect()))
            .collect(),
        broken_internal_links,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use okfx_parser::parse_markdown_document;

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_resolver");
    }

    #[test]
    fn normalizes_concept_paths() {
        assert_eq!(
            normalize_relative_path("concepts/../tables/orders.md"),
            Some("tables/orders.md".to_string())
        );
        assert_eq!(normalize_relative_path("/absolute.md"), None);
        assert_eq!(
            concept_id_from_path("tables/orders.md"),
            Some("tables/orders".to_string())
        );
        assert!(is_reserved_markdown_file("docs/index.md"));
    }

    #[test]
    fn resolves_relative_markdown_targets() {
        assert_eq!(
            resolve_markdown_target("metrics/wau.md", "../tables/events.md#columns"),
            Some("tables/events".to_string())
        );
        assert_eq!(
            resolve_markdown_target("metrics/wau.md", "/runbooks/wau.md"),
            Some("runbooks/wau".to_string())
        );
        assert_eq!(resolve_markdown_target("metrics/wau.md", "#notes"), None);
    }

    #[test]
    fn decodes_markdown_destinations_without_allowing_traversal() {
        assert_eq!(
            resolve_markdown_target("index.md", r"docs/foo_\(bar\).md"),
            Some("docs/foo_(bar)".to_string())
        );
        assert_eq!(
            resolve_markdown_target("index.md", "docs/hello%20world.md"),
            Some("docs/hello world".to_string())
        );
        assert_eq!(
            resolve_markdown_target("index.md", "docs/topic%23one.md"),
            Some("docs/topic#one".to_string())
        );
        assert_eq!(
            resolve_markdown_target("index.md", r"docs/topic\#one.md"),
            Some("docs/topic".to_string())
        );
        assert_eq!(
            resolve_markdown_target("index.md", r"docs/topic\?draft.md"),
            Some("docs/topic".to_string())
        );
        assert_eq!(
            resolve_markdown_target("index.md", "docs/topic%3Fdraft.md"),
            Some("docs/topic?draft".to_string())
        );
        assert_eq!(
            resolve_markdown_target("index.md", "docs/100%.md"),
            Some("docs/100%".to_string())
        );
        assert_eq!(
            resolve_markdown_target("concepts/current.md", "%2e%2e/%2e%2e/outside.md"),
            None
        );
        assert_eq!(
            resolve_markdown_target("index.md", "docs/%00secret.md"),
            None
        );
    }

    #[test]
    fn resolves_links_and_backlinks() {
        let parsed = parse_markdown_document(
            "metrics/wau.md",
            "---\ntype: Metric\n---\n[Events](../tables/events.md)\n[Missing](../tables/missing.md)\n[Docs](https://example.com)\n",
            "metrics/wau",
        );
        let result = resolve_links(
            parsed
                .links
                .into_iter()
                .map(|link| LinkEntry {
                    source_path: "metrics/wau.md".to_string(),
                    link,
                })
                .collect(),
            ["metrics/wau".to_string(), "tables/events".to_string()],
        );

        assert_eq!(result.links.len(), 3);
        assert!(result.links[0].resolved);
        assert_eq!(
            result.links[0].target_concept_id.as_deref(),
            Some("tables/events")
        );
        assert_eq!(result.backlinks["tables/events"], vec!["metrics/wau"]);
        assert_eq!(result.broken_internal_links.len(), 1);
        assert!(result.links[2].resolved);
    }
}
