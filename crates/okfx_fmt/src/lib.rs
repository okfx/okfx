use serde_yaml::{Mapping, Value};

pub const CRATE_NAME: &str = "okfx_fmt";

pub const DEFAULT_FRONTMATTER_KEY_ORDER: &[&str] = &[
    "type",
    "title",
    "description",
    "resource",
    "tags",
    "timestamp",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatDiagnostic {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatResult {
    pub formatted: String,
    pub changed: bool,
    pub diagnostics: Vec<FormatDiagnostic>,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn format_markdown_document(path: impl Into<String>, content: impl AsRef<str>) -> FormatResult {
    format_markdown_document_with_key_order(path, content, DEFAULT_FRONTMATTER_KEY_ORDER)
}

pub fn format_markdown_document_with_key_order(
    path: impl Into<String>,
    content: impl AsRef<str>,
    key_order: &[&str],
) -> FormatResult {
    let path = path.into();
    let content = content.as_ref();
    let Some(split) = split_frontmatter(content) else {
        let formatted = normalize_body(content);
        return FormatResult {
            changed: formatted != content,
            formatted,
            diagnostics: Vec::new(),
        };
    };

    let mut diagnostics = Vec::new();
    let frontmatter = match serde_yaml::from_str::<Value>(split.raw) {
        Ok(Value::Mapping(mapping)) => mapping,
        Ok(Value::Null) => Mapping::new(),
        Ok(_) => {
            diagnostics.push(invalid_frontmatter(
                &path,
                "Frontmatter must be a YAML mapping.",
            ));
            return FormatResult {
                formatted: content.to_string(),
                changed: false,
                diagnostics,
            };
        }
        Err(error) => {
            diagnostics.push(invalid_frontmatter(&path, &error.to_string()));
            return FormatResult {
                formatted: content.to_string(),
                changed: false,
                diagnostics,
            };
        }
    };

    let formatted_frontmatter = stringify_ordered_frontmatter(frontmatter, key_order);
    let formatted = format!(
        "---\n{}---\n\n{}",
        formatted_frontmatter,
        normalize_body(&content[split.body_start_offset..])
    );

    FormatResult {
        changed: formatted != content,
        formatted,
        diagnostics,
    }
}

#[derive(Debug, Clone, Copy)]
struct FrontmatterSplit<'a> {
    raw: &'a str,
    body_start_offset: usize,
}

fn split_frontmatter(content: &str) -> Option<FrontmatterSplit<'_>> {
    let opening_len = if content.starts_with("---\r\n") {
        5
    } else if content.starts_with("---\n") {
        4
    } else {
        return None;
    };
    let rest = &content[opening_len..];
    let mut offset = opening_len;

    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some(FrontmatterSplit {
                raw: &content[opening_len..offset],
                body_start_offset: offset + line.len(),
            });
        }
        offset += line.len();
    }

    None
}

fn stringify_ordered_frontmatter(frontmatter: Mapping, key_order: &[&str]) -> String {
    let mut entries = frontmatter.into_iter().collect::<Vec<_>>();
    entries.sort_by(|(left, _), (right, _)| {
        let left_key = key_name(left);
        let right_key = key_name(right);
        key_rank(&left_key, key_order)
            .cmp(&key_rank(&right_key, key_order))
            .then_with(|| left_key.cmp(&right_key))
    });

    let mut ordered = Mapping::new();
    for (key, value) in entries {
        let value = if key_name(&key) == "timestamp" {
            normalize_timestamp_value(value)
        } else {
            value
        };
        ordered.insert(key, value);
    }

    let mut yaml = serde_yaml::to_string(&ordered).unwrap_or_default();
    yaml = yaml.trim_start_matches("---\n").to_string();
    yaml = yaml.trim_end().to_string();
    format!("{yaml}\n")
}

fn key_name(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn key_rank(key: &str, key_order: &[&str]) -> usize {
    key_order
        .iter()
        .position(|candidate| *candidate == key)
        .unwrap_or(key_order.len())
}

fn normalize_timestamp_value(value: Value) -> Value {
    let Some(timestamp) = value.as_str() else {
        return value;
    };

    if timestamp.len() == 10
        && timestamp.as_bytes().get(4) == Some(&b'-')
        && timestamp.as_bytes().get(7) == Some(&b'-')
    {
        Value::String(format!("{timestamp}T00:00:00.000Z"))
    } else {
        value
    }
}

fn normalize_body(body: &str) -> String {
    let normalized_body = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines = normalized_body.split('\n').collect::<Vec<_>>();
    if normalized_body.ends_with('\n') {
        lines.pop();
    }

    let mut output = Vec::new();
    let mut code_fence = None;
    let mut pending_blank_line = false;

    for line in lines {
        if let Some(fence) = code_fence {
            if is_closing_code_fence(line, fence) {
                output.push(trim_trailing_whitespace(line).to_string());
                code_fence = None;
            } else {
                output.push(line.to_string());
            }
            continue;
        }

        let normalized_line = trim_trailing_whitespace(line);
        if let Some(fence) = opening_code_fence(normalized_line) {
            if pending_blank_line && !output.is_empty() {
                output.push(String::new());
            }
            pending_blank_line = false;
            output.push(normalized_line.to_string());
            code_fence = Some(fence);
        } else if normalized_line.is_empty() {
            pending_blank_line = !output.is_empty();
        } else {
            if pending_blank_line {
                output.push(String::new());
            }
            pending_blank_line = false;
            output.push(normalized_line.to_string());
        }
    }

    format!("{}\n", output.join("\n"))
}

#[derive(Debug, Clone, Copy)]
struct CodeFence {
    marker: u8,
    length: usize,
}

fn opening_code_fence(line: &str) -> Option<CodeFence> {
    let candidate = strip_fence_indent(line)?;
    let marker = *candidate.as_bytes().first()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let length = candidate
        .as_bytes()
        .iter()
        .take_while(|byte| **byte == marker)
        .count();
    if length < 3 || (marker == b'`' && candidate[length..].contains('`')) {
        return None;
    }
    Some(CodeFence { marker, length })
}

fn is_closing_code_fence(line: &str, fence: CodeFence) -> bool {
    let Some(candidate) = strip_fence_indent(line) else {
        return false;
    };
    let length = candidate
        .as_bytes()
        .iter()
        .take_while(|byte| **byte == fence.marker)
        .count();
    length >= fence.length
        && candidate[length..]
            .chars()
            .all(|character| matches!(character, ' ' | '\t'))
}

fn strip_fence_indent(line: &str) -> Option<&str> {
    let spaces = line
        .as_bytes()
        .iter()
        .take_while(|byte| **byte == b' ')
        .count();
    (spaces <= 3).then_some(&line[spaces..])
}

fn trim_trailing_whitespace(line: &str) -> &str {
    line.trim_end_matches([' ', '\t'])
}

fn invalid_frontmatter(path: &str, message: &str) -> FormatDiagnostic {
    FormatDiagnostic {
        code: "spec/invalid-frontmatter".to_string(),
        message: message.to_string(),
        path: Some(path.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_fmt");
    }

    #[test]
    fn formats_frontmatter_and_body() {
        let result = format_markdown_document(
            "concept.md",
            "---\ntitle: Example\ntype: Note\ntimestamp: 2026-07-07\ntags:\n- b\n- a\n---\n# Example   \n\n\nBody   ",
        );

        assert!(result.changed);
        assert!(result.diagnostics.is_empty());
        assert_eq!(
            result.formatted,
            "---\ntype: Note\ntitle: Example\ntags:\n- b\n- a\ntimestamp: 2026-07-07T00:00:00.000Z\n---\n\n# Example\n\nBody\n"
        );
    }

    #[test]
    fn reports_invalid_frontmatter_without_rewriting() {
        let input = "---\ntype: [\n---\n# Bad\n";
        let result = format_markdown_document("bad.md", input);

        assert!(!result.changed);
        assert_eq!(result.formatted, input);
        assert_eq!(result.diagnostics[0].code, "spec/invalid-frontmatter");
    }

    #[test]
    fn normalizes_body_only_files() {
        let result = format_markdown_document("note.md", "# Note   \n\n");

        assert_eq!(result.formatted, "# Note\n");
    }

    #[test]
    fn preserves_fenced_code_whitespace_and_normalizes_surrounding_body() {
        let result = format_markdown_document(
            "concept.md",
            "---\ntitle: Example\ntype: Note\n---\n\n# Example   \n\n\n```text  \nkeep   \n\n\n```   \n\n\nTail   ",
        );

        assert_eq!(
            result.formatted,
            "---\ntype: Note\ntitle: Example\n---\n\n# Example\n\n```text\nkeep   \n\n\n```\n\nTail\n"
        );
    }
}
