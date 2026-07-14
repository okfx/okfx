use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const CRATE_NAME: &str = "okfx_parser";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Advice,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLocation {
    pub line: usize,
    pub column: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRange {
    pub start: SourceLocation,
    pub end: Option<SourceLocation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub path: Option<String>,
    pub location: Option<SourceRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heading {
    pub level: usize,
    pub title: String,
    pub slug: String,
    pub location: SourceRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkdownBody {
    pub raw: String,
    pub text: String,
    pub headings: Vec<Heading>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Internal,
    External,
    Anchor,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub source_concept_id: String,
    pub target_raw: String,
    pub text: Option<String>,
    pub kind: LinkKind,
    pub resolved: bool,
    pub location: SourceRange,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedMarkdownDocument {
    pub path: String,
    pub frontmatter: Option<BTreeMap<String, serde_yaml::Value>>,
    pub frontmatter_raw: Option<String>,
    pub body: MarkdownBody,
    pub links: Vec<Link>,
    pub diagnostics: Vec<Diagnostic>,
    pub content_hash: String,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn parse_markdown_document(
    path: impl Into<String>,
    content: impl AsRef<str>,
    source_concept_id: impl Into<String>,
) -> ParsedMarkdownDocument {
    let path = path.into();
    let source_concept_id = source_concept_id.into();
    let content = content.as_ref();
    let frontmatter_split = split_frontmatter(content);
    let mut diagnostics = Vec::new();
    let mut frontmatter = None;
    let mut frontmatter_raw = None;
    let mut body_raw = content;
    let mut body_start_source_offset = 0;
    let mut body_start_line = 1;

    if let Some(split) = frontmatter_split {
        frontmatter_raw = Some(split.raw.to_string());
        body_raw = &content[split.body_start_offset..];
        body_start_source_offset = utf16_len(&content[..split.body_start_offset]);
        body_start_line = line_number_at(content, split.body_start_offset);

        match parse_frontmatter(split.raw) {
            Ok(parsed) => frontmatter = Some(parsed),
            Err(message) => diagnostics.push(invalid_frontmatter(&path, message)),
        }
    }

    let (body, links) = parse_markdown_body(
        body_raw,
        &source_concept_id,
        body_start_source_offset,
        body_start_line,
    );

    ParsedMarkdownDocument {
        path,
        frontmatter,
        frontmatter_raw,
        body,
        links,
        diagnostics,
        content_hash: format!("sha256:{}", sha256_hex(content.as_bytes())),
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
        let trimmed = line
            .trim_end_matches(['\r', '\n'])
            .trim_end_matches([' ', '\t']);
        if trimmed == "---" {
            let body_start_offset = offset + line.len();
            return Some(FrontmatterSplit {
                raw: &content[opening_len..offset],
                body_start_offset,
            });
        }
        offset += line.len();
    }

    None
}

fn parse_frontmatter(raw: &str) -> Result<BTreeMap<String, serde_yaml::Value>, String> {
    let value =
        serde_yaml::from_str::<serde_yaml::Value>(raw).map_err(|error| error.to_string())?;
    let mapping = match value {
        serde_yaml::Value::Mapping(mapping) => mapping,
        serde_yaml::Value::Null => serde_yaml::Mapping::new(),
        _ => return Err("Frontmatter must be a YAML mapping.".to_string()),
    };

    let mut frontmatter = BTreeMap::new();
    for (key, value) in mapping {
        match key {
            serde_yaml::Value::String(key) => {
                frontmatter.insert(key, value);
            }
            other => {
                frontmatter.insert(format!("{other:?}"), value);
            }
        }
    }

    Ok(frontmatter)
}

fn parse_markdown_body(
    raw: &str,
    source_concept_id: &str,
    body_start_source_offset: usize,
    body_start_line: usize,
) -> (MarkdownBody, Vec<Link>) {
    let mut headings = Vec::new();
    let mut links = Vec::new();
    let mut line_source_offset = 0;
    let mut code_fence = None;
    let link_searchable = mask_inline_code(&mask_fenced_code(raw));

    for (line_index, (line, link_line)) in raw
        .split_inclusive('\n')
        .zip(link_searchable.split_inclusive('\n'))
        .enumerate()
    {
        let line_number = body_start_line + line_index;
        let without_newline = line.trim_end_matches(['\r', '\n']);
        let link_without_newline = link_line.trim_end_matches(['\r', '\n']);
        if let Some(fence) = code_fence {
            if is_closing_code_fence(without_newline, fence) {
                code_fence = None;
            }
            line_source_offset += utf16_len(line);
            continue;
        }
        if let Some(fence) = opening_code_fence(without_newline) {
            code_fence = Some(fence);
            line_source_offset += utf16_len(line);
            continue;
        }
        if let Some(heading) = parse_heading(
            without_newline,
            body_start_source_offset + line_source_offset,
            line_number,
        ) {
            headings.push(heading);
        }
        links.extend(parse_links(
            link_without_newline,
            without_newline,
            source_concept_id,
            body_start_source_offset + line_source_offset,
            line_number,
        ));
        line_source_offset += utf16_len(line);
    }

    (
        MarkdownBody {
            raw: raw.to_string(),
            text: plain_text(raw),
            headings,
        },
        links,
    )
}

fn parse_heading(line: &str, absolute_line_offset: usize, line_number: usize) -> Option<Heading> {
    let (hashes, title) = parse_atx_heading(line)?;
    let line_source_length = utf16_len(line);
    Some(Heading {
        level: hashes,
        slug: slugify_heading(&title),
        title,
        location: SourceRange {
            start: SourceLocation {
                line: line_number,
                column: 1,
                offset: absolute_line_offset,
            },
            end: Some(SourceLocation {
                line: line_number,
                column: line_source_length + 1,
                offset: absolute_line_offset + line_source_length,
            }),
        },
    })
}

fn parse_atx_heading(line: &str) -> Option<(usize, String)> {
    let indent = line
        .as_bytes()
        .iter()
        .take_while(|byte| **byte == b' ')
        .count();
    if indent > 3 {
        return None;
    }

    let candidate = &line[indent..];
    let hashes = candidate
        .as_bytes()
        .iter()
        .take_while(|byte| **byte == b'#')
        .count();
    if !(1..=6).contains(&hashes) {
        return None;
    }

    let remainder = &candidate[hashes..];
    if !remainder.is_empty() && !remainder.starts_with([' ', '\t']) {
        return None;
    }

    let trimmed_end = remainder.trim_end_matches([' ', '\t']);
    let without_hashes = trimmed_end.trim_end_matches('#');
    let content =
        if without_hashes.len() < trimmed_end.len() && without_hashes.ends_with([' ', '\t']) {
            without_hashes.trim_end_matches([' ', '\t'])
        } else {
            trimmed_end
        };
    Some((hashes, content.trim_start_matches([' ', '\t']).to_string()))
}

fn parse_links(
    line: &str,
    source_line: &str,
    source_concept_id: &str,
    absolute_line_offset: usize,
    line_number: usize,
) -> Vec<Link> {
    let bytes = line.as_bytes();
    let mut links = Vec::new();
    let mut cursor = 0;

    while cursor < bytes.len() {
        let Some(open_bracket_relative) = line[cursor..].find('[') else {
            break;
        };
        let open_bracket = cursor + open_bracket_relative;
        if is_escaped_delimiter(bytes, open_bracket) {
            cursor = open_bracket + 1;
            continue;
        }
        if open_bracket > 0
            && bytes[open_bracket - 1] == b'!'
            && !is_escaped_delimiter(bytes, open_bracket - 1)
        {
            cursor = open_bracket + 1;
            continue;
        }
        let Some(close_bracket) = find_unescaped_byte(bytes, open_bracket + 1, b']') else {
            break;
        };
        if close_bracket == open_bracket + 1 || !line[close_bracket + 1..].starts_with('(') {
            cursor = close_bracket + 1;
            continue;
        }
        let target_start = close_bracket + 2;
        let Some((target_end, close_paren)) = parse_link_destination(line, target_start) else {
            cursor = close_bracket + 1;
            continue;
        };
        let target_raw = line[target_start..target_end].to_string();
        let text = line[open_bracket + 1..close_bracket].trim().to_string();

        links.push(Link {
            source_concept_id: source_concept_id.to_string(),
            target_raw: target_raw.clone(),
            text: if text.is_empty() { None } else { Some(text) },
            kind: classify_link_target(&target_raw),
            resolved: false,
            location: SourceRange {
                start: SourceLocation {
                    line: line_number,
                    column: utf16_len(&source_line[..open_bracket]) + 1,
                    offset: absolute_line_offset + utf16_len(&source_line[..open_bracket]),
                },
                end: Some(SourceLocation {
                    line: line_number,
                    column: utf16_len(&source_line[..close_paren + 1]) + 1,
                    offset: absolute_line_offset + utf16_len(&source_line[..close_paren + 1]),
                }),
            },
        });
        cursor = close_paren + 1;
    }

    links
}

fn parse_link_destination(line: &str, target_start: usize) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut depth = 0;
    let mut cursor = target_start;

    while cursor < bytes.len() {
        let character = line[cursor..].chars().next()?;
        if character == '(' && !is_escaped_delimiter(bytes, cursor) {
            depth += 1;
        } else if character == ')' && !is_escaped_delimiter(bytes, cursor) {
            if depth == 0 {
                return (cursor > target_start).then_some((cursor, cursor));
            }
            depth -= 1;
        } else if character.is_whitespace() {
            if depth != 0 || cursor == target_start {
                return None;
            }
            return parse_link_title(line, cursor, target_start);
        }
        cursor += character.len_utf8();
    }

    None
}

fn parse_link_title(line: &str, target_end: usize, target_start: usize) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut cursor = target_end;
    while bytes
        .get(cursor)
        .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
    {
        cursor += 1;
    }
    let quote = *bytes.get(cursor)?;
    if !matches!(quote, b'\'' | b'"') || target_end == target_start {
        return None;
    }

    cursor += 1;
    while cursor < bytes.len() {
        if bytes[cursor] == quote && !is_escaped_delimiter(bytes, cursor) {
            return (bytes.get(cursor + 1) == Some(&b')')).then_some((target_end, cursor + 1));
        }
        cursor += 1;
    }

    None
}

fn find_unescaped_byte(value: &[u8], start: usize, needle: u8) -> Option<usize> {
    value[start..]
        .iter()
        .enumerate()
        .find_map(|(offset, byte)| {
            let index = start + offset;
            (*byte == needle && !is_escaped_delimiter(value, index)).then_some(index)
        })
}

fn classify_link_target(target: &str) -> LinkKind {
    if target.is_empty() {
        LinkKind::Unknown
    } else if target.starts_with('#') {
        LinkKind::Anchor
    } else if target.starts_with("//") || looks_like_scheme(target) {
        LinkKind::External
    } else {
        LinkKind::Internal
    }
}

fn looks_like_scheme(target: &str) -> bool {
    let Some(colon) = target.find(':') else {
        return false;
    };
    let scheme = &target[..colon];
    !scheme.is_empty()
        && scheme.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')
        })
        && scheme
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
}

fn plain_text(markdown: &str) -> String {
    let mut text = String::new();
    let mut code_fence = None;

    for line in markdown.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(fence) = code_fence {
            if is_closing_code_fence(line, fence) {
                code_fence = None;
            }
            continue;
        }
        if let Some(fence) = opening_code_fence(line) {
            code_fence = Some(fence);
            continue;
        }
        let without_links = strip_inline_links(line);
        let heading_text = parse_atx_heading(&without_links)
            .map(|(_, title)| title)
            .unwrap_or(without_links);
        let stripped = heading_text.replace(['*', '_', '~', '`', '>', '-'], " ");
        text.push_str(&stripped);
        text.push(' ');
    }

    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_inline_links(markdown: &str) -> String {
    let bytes = markdown.as_bytes();
    let mut output = String::with_capacity(markdown.len());
    let mut emitted_through = 0;
    let mut cursor = 0;

    while cursor < bytes.len() {
        let Some(open_relative) = bytes[cursor..].iter().position(|byte| *byte == b'[') else {
            break;
        };
        let open = cursor + open_relative;
        if is_escaped_delimiter(bytes, open) {
            cursor = open + 1;
            continue;
        }

        let image = open > 0 && bytes[open - 1] == b'!' && !is_escaped_delimiter(bytes, open - 1);
        let Some(close_bracket) = find_unescaped_byte(bytes, open + 1, b']') else {
            break;
        };
        if close_bracket == open + 1 || !markdown[close_bracket + 1..].starts_with('(') {
            cursor = close_bracket + 1;
            continue;
        }
        let Some((_, close_paren)) = parse_link_destination(markdown, close_bracket + 2) else {
            cursor = close_bracket + 1;
            continue;
        };

        output.push_str(&markdown[emitted_through..if image { open - 1 } else { open }]);
        if !image {
            output.push_str(&markdown[open + 1..close_bracket]);
        }
        emitted_through = close_paren + 1;
        cursor = emitted_through;
    }

    output.push_str(&markdown[emitted_through..]);
    output
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

fn mask_fenced_code(markdown: &str) -> String {
    let mut masked = String::with_capacity(markdown.len());
    let mut code_fence = None;

    for line in markdown.split_inclusive('\n') {
        let without_newline = line.trim_end_matches(['\r', '\n']);
        if let Some(fence) = code_fence {
            masked.push_str(&mask_preserving_line_endings(line));
            if is_closing_code_fence(without_newline, fence) {
                code_fence = None;
            }
            continue;
        }
        if let Some(fence) = opening_code_fence(without_newline) {
            code_fence = Some(fence);
            masked.push_str(&mask_preserving_line_endings(line));
            continue;
        }
        masked.push_str(line);
    }

    masked
}

fn mask_inline_code(markdown: &str) -> String {
    let bytes = markdown.as_bytes();
    let mut masked = bytes.to_vec();
    let mut cursor = 0;

    while cursor < bytes.len() {
        let Some(opener_relative) = bytes[cursor..].iter().position(|byte| *byte == b'`') else {
            break;
        };
        let opener = cursor + opener_relative;
        if is_escaped_delimiter(bytes, opener) {
            cursor = opener + 1;
            continue;
        }

        let delimiter_length = backtick_run_length(bytes, opener);
        let mut search_from = opener + delimiter_length;
        let mut closing_end = None;
        while search_from < bytes.len() {
            let Some(candidate_relative) =
                bytes[search_from..].iter().position(|byte| *byte == b'`')
            else {
                break;
            };
            let candidate = search_from + candidate_relative;
            let candidate_length = backtick_run_length(bytes, candidate);
            if candidate_length == delimiter_length {
                closing_end = Some(candidate + candidate_length);
                break;
            }
            search_from = candidate + candidate_length;
        }

        let Some(closing_end) = closing_end else {
            cursor = opener + delimiter_length;
            continue;
        };
        for byte in &mut masked[opener..closing_end] {
            if !matches!(*byte, b'\r' | b'\n') {
                *byte = b' ';
            }
        }
        cursor = closing_end;
    }

    String::from_utf8(masked).expect("masking Markdown preserves valid UTF-8")
}

fn mask_preserving_line_endings(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'\r' => '\r',
            b'\n' => '\n',
            _ => ' ',
        })
        .collect()
}

fn backtick_run_length(value: &[u8], start: usize) -> usize {
    value[start..]
        .iter()
        .take_while(|byte| **byte == b'`')
        .count()
}

fn is_escaped_delimiter(value: &[u8], index: usize) -> bool {
    value[..index]
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\\')
        .count()
        % 2
        == 1
}

fn slugify_heading(title: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;

    for character in title.trim().to_lowercase().chars() {
        if character.is_alphanumeric() {
            slug.push(character);
            previous_dash = false;
        } else if (character.is_whitespace() || character == '-')
            && !previous_dash
            && !slug.is_empty()
        {
            slug.push('-');
            previous_dash = true;
        }
    }

    slug.trim_matches('-').to_string()
}

fn invalid_frontmatter(path: &str, message: String) -> Diagnostic {
    Diagnostic {
        code: "spec/invalid-frontmatter".to_string(),
        severity: DiagnosticSeverity::Error,
        message,
        path: Some(path.to_string()),
        location: Some(SourceRange {
            start: SourceLocation {
                line: 1,
                column: 1,
                offset: 0,
            },
            end: None,
        }),
    }
}

fn line_number_at(content: &str, offset: usize) -> usize {
    content[..offset]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn sha256_hex(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    let digest = hasher.finalize();
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_parser");
    }

    #[test]
    fn parses_atx_indentation_and_closing_markers() {
        let parsed = parse_markdown_document(
            "concept.md",
            "# C#\n## Closed ##\n###\n   #### Indented ####\n    # Code block\n####### Not a heading\n",
            "concept",
        );

        assert_eq!(
            parsed
                .body
                .headings
                .iter()
                .map(|heading| (heading.level, heading.title.as_str(), heading.slug.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (1, "C#", "c"),
                (2, "Closed", "closed"),
                (3, "", ""),
                (4, "Indented", "indented")
            ]
        );
        assert!(parsed.body.text.contains("C# Closed"));
        assert!(parsed.body.text.contains("####### Not a heading"));
    }

    #[test]
    fn parses_frontmatter_headings_links_and_hash() {
        let parsed = parse_markdown_document(
            "concepts/wau.md",
            "---\ntype: Metric\ntitle: Weekly Active Users\ntags:\n  - analytics\n---\n\n# Weekly Active Users\n\nSee [Events](../tables/events.md), [Notes](#notes), and [Docs](https://example.com).\n\n## Notes\n",
            "concepts/wau",
        );

        assert!(parsed.diagnostics.is_empty());
        assert_eq!(
            parsed
                .frontmatter
                .as_ref()
                .and_then(|frontmatter| frontmatter.get("type"))
                .and_then(serde_yaml::Value::as_str),
            Some("Metric")
        );
        assert_eq!(parsed.body.headings[0].title, "Weekly Active Users");
        assert_eq!(parsed.body.headings[0].location.start.line, 8);
        assert_eq!(parsed.body.headings[1].slug, "notes");
        assert_eq!(parsed.links.len(), 3);
        assert_eq!(parsed.links[0].kind, LinkKind::Internal);
        assert_eq!(parsed.links[1].kind, LinkKind::Anchor);
        assert_eq!(parsed.links[2].kind, LinkKind::External);
        assert!(parsed.content_hash.starts_with("sha256:"));
        assert_eq!(parsed.content_hash.len(), "sha256:".len() + 64);
    }

    #[test]
    fn reports_invalid_yaml_frontmatter() {
        let parsed = parse_markdown_document("bad.md", "---\ntype: [\n---\n# Bad\n", "bad");

        assert_eq!(parsed.frontmatter, None);
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].code, "spec/invalid-frontmatter");
        assert_eq!(parsed.diagnostics[0].severity, DiagnosticSeverity::Error);
    }

    #[test]
    fn treats_missing_frontmatter_as_body_only() {
        let parsed = parse_markdown_document("note.md", "# Note\n\n[Other](other.md)\n", "note");

        assert!(parsed.frontmatter.is_none());
        assert!(parsed.diagnostics.is_empty());
        assert_eq!(parsed.body.headings[0].title, "Note");
        assert_eq!(parsed.links[0].target_raw, "other.md");
    }

    #[test]
    fn requires_frontmatter_mapping() {
        let parsed = parse_markdown_document("list.md", "---\n- nope\n---\n# Bad\n", "list");

        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(
            parsed.diagnostics[0].message,
            "Frontmatter must be a YAML mapping."
        );
    }

    #[test]
    fn accepts_trailing_whitespace_on_frontmatter_closers() {
        let parsed =
            parse_markdown_document("note.md", "---\ntype: Note\n---   \n# Note\n", "note");

        assert!(parsed.frontmatter.is_some());
        assert_eq!(parsed.body.headings[0].title, "Note");
    }

    #[test]
    fn ignores_headings_and_links_inside_code_fences() {
        let parsed = parse_markdown_document(
            "note.md",
            "# Visible\n[Visible](visible.md)\n```markdown\n# Hidden\n[Hidden](hidden.md)\n```\n~~~text\n## Also hidden\n[Also hidden](also-hidden.md)\n~~~\n## Also visible\n",
            "note",
        );

        assert_eq!(
            parsed
                .body
                .headings
                .iter()
                .map(|heading| heading.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Visible", "Also visible"]
        );
        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.target_raw.as_str())
                .collect::<Vec<_>>(),
            vec!["visible.md"]
        );
        assert!(!parsed.body.text.contains("Hidden"));
    }

    #[test]
    fn ignores_links_inside_inline_code_spans() {
        let parsed = parse_markdown_document(
            "note.md",
            "# Visible\n`[single](hidden-single.md)`\n``before\n[multiline](hidden-multiline.md)\nafter``\n\\`[literal](visible.md)\n[Also visible](also-visible.md)\n",
            "note",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.target_raw.as_str())
                .collect::<Vec<_>>(),
            vec!["visible.md", "also-visible.md"]
        );
    }

    #[test]
    fn parses_balanced_and_escaped_parentheses_in_link_destinations() {
        let parsed = parse_markdown_document(
            "note.md",
            "[Wiki](https://example.com/Foo_(bar))\n[Nested](docs/foo_(bar_(baz)).md \"A title\")\n[Escaped](docs/foo_\\(bar\\).md)\n[Broken](docs/foo_(bar.md)\n",
            "note",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.target_raw.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://example.com/Foo_(bar)",
                "docs/foo_(bar_(baz)).md",
                "docs/foo_\\(bar\\).md"
            ]
        );
        assert_eq!(parsed.links[0].location.end.as_ref().unwrap().offset, 37);
    }

    #[test]
    fn keeps_link_labels_without_leaking_destinations_into_plain_text() {
        let parsed = parse_markdown_document(
            "note.md",
            r#"[Wiki](docs/foo_(bar).md "Reference") ![Diagram](images/diagram_(large).png) `[Code](literal.md)`
"#,
            "note",
        );

        assert_eq!(parsed.body.text, "Wiki Code");
    }

    #[test]
    fn reports_javascript_compatible_utf16_locations() {
        let content = "---\ntitle: 文档\n---\n# 标题😀\n😀 `代码` [目标](target.md)\n";
        let parsed = parse_markdown_document("note.md", content, "note");
        let heading_start = content.find("# 标题").unwrap();
        let heading_end = content[heading_start..].find('\n').unwrap() + heading_start;
        let link_start = content.find("[目标]").unwrap();
        let link_end = content[link_start..].find(')').unwrap() + link_start + 1;

        assert_eq!(
            parsed.body.headings[0].location.start.offset,
            utf16_len(&content[..heading_start])
        );
        assert_eq!(
            parsed.body.headings[0]
                .location
                .end
                .as_ref()
                .unwrap()
                .offset,
            utf16_len(&content[..heading_end])
        );
        assert_eq!(
            parsed.links[0].location.start.offset,
            utf16_len(&content[..link_start])
        );
        assert_eq!(parsed.links[0].location.start.column, 9);
        assert_eq!(
            parsed.links[0].location.end.as_ref().unwrap().offset,
            utf16_len(&content[..link_end])
        );
    }

    #[test]
    fn honors_escaped_link_and_image_markers() {
        let parsed = parse_markdown_document(
            "note.md",
            "\\[Escaped](hidden.md)\n\\\\[Visible](visible.md)\n![Image](image.png)\n\\![Not an image](visible-after-bang.md)\n",
            "note",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.target_raw.as_str())
                .collect::<Vec<_>>(),
            vec!["visible.md", "visible-after-bang.md"]
        );
    }
}
