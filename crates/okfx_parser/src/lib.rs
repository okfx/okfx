use regex::Regex;
use saphyr::{Scalar, ScalarStyle, Tag};
use saphyr_parser::{Event, EventReceiver, Parser};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

pub const CRATE_NAME: &str = "okfx_parser";
const MAX_LINK_DESTINATION_NESTING: usize = 64;
static EXPLICIT_FLOAT_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+|[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*))$",
    )
    .expect("explicit float regex is valid")
});
static TIMESTAMP_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:(?:t|T|[ \t]+)[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(?:\.[0-9]+)?(?:[ \t]*(?:Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$",
    )
    .expect("timestamp regex is valid")
});

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
    } else if content.starts_with("---\n") || content.starts_with("---\r") {
        4
    } else {
        return None;
    };
    let rest = &content[opening_len..];
    let mut offset = opening_len;

    for line in split_lines_inclusive(rest) {
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
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");

    let (saphyr_input, tag_validation) = match prepare_saphyr_input(&normalized) {
        Ok(prepared) => prepared,
        Err(error) => {
            return match serde_yaml::from_str::<serde_yaml::Value>(&normalized) {
                Ok(value) => finish_frontmatter(value),
                Err(_) => Err(error),
            };
        }
    };

    if tag_validation.invalid_collection_tag {
        return Err("Frontmatter contains an invalid explicit YAML tag value.".to_string());
    }

    let mut documents = load_tagged_yaml_documents(&saphyr_input)?;
    if documents.is_empty() {
        return Err("Frontmatter must be a YAML mapping.".to_string());
    }
    if documents.len() > 1 {
        return Err("Frontmatter must contain exactly one YAML document.".to_string());
    }
    let document = documents.pop().unwrap_or(TaggedYamlNode::BadValue);
    finish_frontmatter(tagged_saphyr_document_to_serde(document)?)
}

fn finish_frontmatter(
    value: serde_yaml::Value,
) -> Result<BTreeMap<String, serde_yaml::Value>, String> {
    if !has_only_string_mapping_keys(&value) {
        return Err("Frontmatter keys must be strings.".to_string());
    }
    if contains_non_finite_number(&value) {
        return Err("Frontmatter numbers must be finite.".to_string());
    }
    let mapping = match value {
        serde_yaml::Value::Mapping(mapping) => mapping,
        _ => return Err("Frontmatter must be a YAML mapping.".to_string()),
    };

    let mut frontmatter = BTreeMap::new();
    for (key, value) in mapping {
        match key {
            serde_yaml::Value::String(key) => {
                frontmatter.insert(key, value);
            }
            _ => return Err("Frontmatter keys must be strings.".to_string()),
        }
    }

    Ok(frontmatter)
}

#[derive(Default)]
struct YamlTagValidator {
    invalid_collection_tag: bool,
}

impl<'input> EventReceiver<'input> for YamlTagValidator {
    fn on_event(&mut self, event: Event<'input>) {
        match event {
            Event::Scalar(_, _, _, _) => {}
            Event::SequenceStart(_, tag) => {
                self.invalid_collection_tag |= tag.as_deref().is_some_and(|tag| {
                    tag.is_yaml_core_schema()
                        && !matches!(tag.suffix.as_str(), "seq" | "omap" | "pairs")
                });
            }
            Event::MappingStart(_, tag) => {
                self.invalid_collection_tag |= tag.as_deref().is_some_and(|tag| {
                    tag.is_yaml_core_schema() && !matches!(tag.suffix.as_str(), "map" | "set")
                });
            }
            _ => {}
        }
    }
}

#[derive(Clone)]
enum TaggedYamlNode<'input> {
    Scalar(Cow<'input, str>, ScalarStyle, Option<Cow<'input, Tag>>),
    Sequence(Vec<Self>, Option<Cow<'input, Tag>>),
    Mapping(Vec<(Self, Self)>, Option<Cow<'input, Tag>>),
    BadValue,
}

enum TaggedYamlContainer<'input> {
    Sequence {
        values: Vec<TaggedYamlNode<'input>>,
        tag: Option<Cow<'input, Tag>>,
        anchor: usize,
    },
    Mapping {
        entries: Vec<(TaggedYamlNode<'input>, TaggedYamlNode<'input>)>,
        pending_key: Option<TaggedYamlNode<'input>>,
        tag: Option<Cow<'input, Tag>>,
        anchor: usize,
    },
}

#[derive(Default)]
struct TaggedYamlLoader<'input> {
    documents: Vec<TaggedYamlNode<'input>>,
    stack: Vec<TaggedYamlContainer<'input>>,
    root: Option<TaggedYamlNode<'input>>,
    anchors: BTreeMap<usize, TaggedYamlNode<'input>>,
    error: Option<String>,
}

impl<'input> TaggedYamlLoader<'input> {
    fn insert(&mut self, node: TaggedYamlNode<'input>, anchor: usize) {
        if anchor > 0 {
            self.anchors.insert(anchor, node.clone());
        }
        match self.stack.last_mut() {
            Some(TaggedYamlContainer::Sequence { values, .. }) => values.push(node),
            Some(TaggedYamlContainer::Mapping {
                entries,
                pending_key,
                ..
            }) => {
                if let Some(key) = pending_key.take() {
                    entries.push((key, node));
                } else {
                    *pending_key = Some(node);
                }
            }
            None if self.root.is_none() => self.root = Some(node),
            None => {
                self.error.get_or_insert_with(|| {
                    "Frontmatter contains multiple YAML roots in one document.".to_string()
                });
            }
        };
    }

    fn close_sequence(&mut self) {
        let Some(TaggedYamlContainer::Sequence {
            values,
            tag,
            anchor,
        }) = self.stack.pop()
        else {
            self.error
                .get_or_insert_with(|| "Unexpected YAML sequence terminator.".to_string());
            return;
        };
        self.insert(TaggedYamlNode::Sequence(values, tag), anchor);
    }

    fn close_mapping(&mut self) {
        let Some(TaggedYamlContainer::Mapping {
            entries,
            pending_key,
            tag,
            anchor,
        }) = self.stack.pop()
        else {
            self.error
                .get_or_insert_with(|| "Unexpected YAML mapping terminator.".to_string());
            return;
        };
        if pending_key.is_some() {
            self.error
                .get_or_insert_with(|| "YAML mapping is missing a value.".to_string());
        }
        self.insert(TaggedYamlNode::Mapping(entries, tag), anchor);
    }

    fn finish(self) -> Result<Vec<TaggedYamlNode<'input>>, String> {
        if let Some(error) = self.error {
            return Err(error);
        }
        if !self.stack.is_empty() || self.root.is_some() {
            return Err("YAML frontmatter ended before the document was complete.".to_string());
        }
        Ok(self.documents)
    }
}

impl<'input> EventReceiver<'input> for TaggedYamlLoader<'input> {
    fn on_event(&mut self, event: Event<'input>) {
        match event {
            Event::DocumentStart(_) => {
                self.root = None;
                self.anchors.clear();
            }
            Event::DocumentEnd => {
                if !self.stack.is_empty() {
                    self.error.get_or_insert_with(|| {
                        "YAML frontmatter ended before the document was complete.".to_string()
                    });
                }
                self.documents
                    .push(self.root.take().unwrap_or(TaggedYamlNode::BadValue));
            }
            Event::Scalar(value, style, anchor, tag) => {
                self.insert(TaggedYamlNode::Scalar(value, style, tag), anchor);
            }
            Event::SequenceStart(anchor, tag) => {
                self.stack.push(TaggedYamlContainer::Sequence {
                    values: Vec::new(),
                    tag,
                    anchor,
                });
            }
            Event::SequenceEnd => self.close_sequence(),
            Event::MappingStart(anchor, tag) => {
                self.stack.push(TaggedYamlContainer::Mapping {
                    entries: Vec::new(),
                    pending_key: None,
                    tag,
                    anchor,
                });
            }
            Event::MappingEnd => self.close_mapping(),
            Event::Alias(anchor) => {
                let node = self
                    .anchors
                    .get(&anchor)
                    .cloned()
                    .unwrap_or(TaggedYamlNode::BadValue);
                self.insert(node, 0);
            }
            Event::Nothing | Event::StreamStart | Event::StreamEnd => {}
        }
    }
}

fn prepare_saphyr_input(raw: &str) -> Result<(String, YamlTagValidator), String> {
    let mut input = normalize_yaml_separator_tabs(raw);
    loop {
        let mut parser = Parser::new_from_str(&input);
        let mut detector = YamlTagValidator::default();
        match parser.load(&mut detector, true) {
            Ok(()) => return Ok((input, detector)),
            Err(error)
                if error.info() == "':' must be followed by a valid YAML whitespace"
                    && replace_separator_tab(&mut input, error.marker()) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn load_tagged_yaml_documents(raw: &str) -> Result<Vec<TaggedYamlNode<'_>>, String> {
    let mut parser = Parser::new_from_str(raw);
    let mut loader = TaggedYamlLoader::default();
    parser
        .load(&mut loader, true)
        .map_err(|error| error.to_string())?;
    loader.finish()
}

fn normalize_yaml_separator_tabs(raw: &str) -> String {
    let mut normalized = String::with_capacity(raw.len());
    let mut block_scalar_indent = None;
    let mut quote = None;

    for line in split_lines_inclusive(raw) {
        let content = line.trim_end_matches(['\r', '\n']);
        let ending = &line[content.len()..];
        let indent = content.bytes().take_while(|byte| *byte == b' ').count();
        let blank = content
            .chars()
            .all(|character| matches!(character, ' ' | '\t'));

        if let Some(parent_indent) = block_scalar_indent {
            if blank || indent > parent_indent {
                normalized.push_str(line);
                continue;
            }
            block_scalar_indent = None;
        }

        if quote.is_none() && starts_block_scalar(content) {
            block_scalar_indent = Some(indent);
        }
        normalized.push_str(&replace_unquoted_separator_tabs(content, &mut quote));
        normalized.push_str(ending);
    }

    normalized
}

fn replace_unquoted_separator_tabs(line: &str, quote: &mut Option<u8>) -> String {
    let bytes = line.as_bytes();
    let mut normalized = bytes.to_vec();
    let mut cursor = 0;

    while cursor < bytes.len() {
        match *quote {
            Some(b'\'') => {
                if bytes[cursor] == b'\'' {
                    if bytes.get(cursor + 1) == Some(&b'\'') {
                        cursor += 2;
                        continue;
                    }
                    *quote = None;
                }
            }
            Some(b'"') => {
                if bytes[cursor] == b'\\' {
                    cursor += escaped_character_width(&line[cursor + 1..]) + 1;
                    continue;
                }
                if bytes[cursor] == b'"' {
                    *quote = None;
                }
            }
            Some(_) => unreachable!(),
            None => match bytes[cursor] {
                b'#' if cursor == 0 || bytes[cursor - 1].is_ascii_whitespace() => break,
                b'\'' | b'"' if yaml_quote_can_start(bytes, cursor) => {
                    *quote = Some(bytes[cursor]);
                }
                b':' if bytes.get(cursor + 1) == Some(&b'\t') => {
                    normalized[cursor + 1] = b' ';
                }
                _ => {}
            },
        }
        cursor += 1;
    }

    String::from_utf8(normalized).expect("replacing ASCII YAML separators preserves UTF-8")
}

fn escaped_character_width(value: &str) -> usize {
    value.chars().next().map(char::len_utf8).unwrap_or_default()
}

fn yaml_quote_can_start(bytes: &[u8], cursor: usize) -> bool {
    cursor == 0
        || bytes[cursor - 1].is_ascii_whitespace()
        || matches!(bytes[cursor - 1], b'[' | b'{' | b',' | b':' | b'?' | b'-')
}

fn starts_block_scalar(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut quote = None;
    let mut cursor = 0;
    let first_content = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());

    while cursor < bytes.len() {
        match quote {
            Some(b'\'') => {
                if bytes[cursor] == b'\'' {
                    if bytes.get(cursor + 1) == Some(&b'\'') {
                        cursor += 2;
                        continue;
                    }
                    quote = None;
                }
            }
            Some(b'"') => {
                if bytes[cursor] == b'\\' {
                    cursor += escaped_character_width(&line[cursor + 1..]) + 1;
                    continue;
                }
                if bytes[cursor] == b'"' {
                    quote = None;
                }
            }
            Some(_) => unreachable!(),
            None => match bytes[cursor] {
                b'#' if cursor == 0 || bytes[cursor - 1].is_ascii_whitespace() => return false,
                b'\'' | b'"' if yaml_quote_can_start(bytes, cursor) => {
                    quote = Some(bytes[cursor]);
                }
                b':' if bytes.get(cursor + 1).is_some_and(u8::is_ascii_whitespace) => {
                    let indicator = skip_ascii_whitespace(bytes, cursor + 1);
                    if valid_block_scalar_indicator(&line[indicator..]) {
                        return true;
                    }
                }
                b'-' if cursor == first_content
                    && bytes.get(cursor + 1).is_some_and(u8::is_ascii_whitespace) =>
                {
                    let indicator = skip_ascii_whitespace(bytes, cursor + 1);
                    if valid_block_scalar_indicator(&line[indicator..]) {
                        return true;
                    }
                }
                _ => {}
            },
        }
        cursor += 1;
    }
    false
}

fn skip_ascii_whitespace(bytes: &[u8], mut cursor: usize) -> usize {
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    cursor
}

fn valid_block_scalar_indicator(value: &str) -> bool {
    let Some(marker) = value.as_bytes().first() else {
        return false;
    };
    if !matches!(marker, b'|' | b'>') {
        return false;
    }
    let modifiers = value[1..]
        .split_once('#')
        .map(|(before, _)| before)
        .unwrap_or(&value[1..])
        .trim();
    if modifiers.len() > 2 {
        return false;
    }
    let mut chomping = false;
    let mut indentation = false;
    for byte in modifiers.bytes() {
        match byte {
            b'+' | b'-' if !chomping => chomping = true,
            b'1'..=b'9' if !indentation => indentation = true,
            _ => return false,
        }
    }
    true
}

fn replace_separator_tab(input: &mut String, marker: &saphyr_parser::Marker) -> bool {
    let Some(line_start) = line_start_offset(input, marker.line()) else {
        return false;
    };
    let line = &input[line_start..];
    let column = marker.col();
    if column < 2 {
        return false;
    }
    let mut characters = line.char_indices();
    let Some((colon_offset, ':')) = characters.nth(column - 2) else {
        return false;
    };
    let Some((tab_offset, '\t')) = characters.next() else {
        return false;
    };
    debug_assert!(tab_offset > colon_offset);
    let tab_offset = line_start + tab_offset;
    input.replace_range(tab_offset..tab_offset + 1, " ");
    true
}

fn line_start_offset(value: &str, line_number: usize) -> Option<usize> {
    if line_number == 0 {
        return None;
    }
    let mut offset = 0;
    for _ in 1..line_number {
        offset += value[offset..].find('\n')? + 1;
    }
    Some(offset)
}

fn tagged_saphyr_document_to_serde(value: TaggedYamlNode<'_>) -> Result<serde_yaml::Value, String> {
    let TaggedYamlNode::Mapping(entries, tag) = value else {
        return Err("Frontmatter must be a YAML mapping.".to_string());
    };
    match tag.as_deref() {
        None => tagged_mapping_entries_to_serde(entries),
        Some(tag) if tag.is_yaml_core_schema() && tag.suffix == "map" => {
            tagged_mapping_entries_to_serde(entries)
        }
        Some(tag) if tag.is_yaml_core_schema() && tag.suffix == "set" => {
            tagged_set_to_serde(entries)
        }
        _ => Err("Frontmatter must be a YAML mapping.".to_string()),
    }
}

fn tagged_saphyr_to_serde(value: TaggedYamlNode<'_>) -> Result<serde_yaml::Value, String> {
    match value {
        TaggedYamlNode::Scalar(value, style, tag) => {
            tagged_scalar_to_serde(value, style, tag.as_deref())
        }
        TaggedYamlNode::Sequence(values, tag) => match tag.as_deref() {
            None => tagged_sequence_to_serde(values),
            Some(tag) if tag.is_yaml_core_schema() && tag.suffix == "seq" => {
                tagged_sequence_to_serde(values)
            }
            Some(tag) if tag.is_yaml_core_schema() && tag.suffix == "omap" => {
                tagged_pairs_to_serde(values, true)
            }
            Some(tag) if tag.is_yaml_core_schema() && tag.suffix == "pairs" => {
                tagged_pairs_to_serde(values, false)
            }
            Some(tag) if !tag.is_yaml_core_schema() => {
                Ok(wrap_custom_yaml_tag(tag, tagged_sequence_to_serde(values)?))
            }
            _ => Err(invalid_explicit_yaml_tag()),
        },
        TaggedYamlNode::Mapping(entries, tag) => match tag.as_deref() {
            None => tagged_mapping_entries_to_serde(entries),
            Some(tag) if tag.is_yaml_core_schema() && tag.suffix == "map" => {
                tagged_mapping_entries_to_serde(entries)
            }
            Some(tag) if tag.is_yaml_core_schema() && tag.suffix == "set" => {
                tagged_set_to_serde(entries)
            }
            Some(tag) if !tag.is_yaml_core_schema() => Ok(wrap_custom_yaml_tag(
                tag,
                tagged_mapping_entries_to_serde(entries)?,
            )),
            _ => Err(invalid_explicit_yaml_tag()),
        },
        TaggedYamlNode::BadValue => {
            Err("Frontmatter must not contain unresolved YAML aliases.".to_string())
        }
    }
}

fn tagged_sequence_to_serde(values: Vec<TaggedYamlNode<'_>>) -> Result<serde_yaml::Value, String> {
    values
        .into_iter()
        .map(tagged_saphyr_to_serde)
        .collect::<Result<Vec<_>, _>>()
        .map(serde_yaml::Value::Sequence)
}

fn tagged_mapping_entries_to_serde(
    entries: Vec<(TaggedYamlNode<'_>, TaggedYamlNode<'_>)>,
) -> Result<serde_yaml::Value, String> {
    let mut converted = serde_yaml::Mapping::new();
    for (key, value) in entries {
        let key = serde_yaml::Value::String(tagged_mapping_key_to_string(key)?);
        if converted.contains_key(&key) {
            return Err("Frontmatter mapping keys must be unique.".to_string());
        }
        converted.insert(key, tagged_saphyr_to_serde(value)?);
    }
    Ok(serde_yaml::Value::Mapping(converted))
}

fn tagged_mapping_key_to_string(value: TaggedYamlNode<'_>) -> Result<String, String> {
    match value {
        TaggedYamlNode::Scalar(value, _, Some(tag)) if !tag.is_yaml_core_schema() => {
            Ok(value.into_owned())
        }
        value => match tagged_saphyr_to_serde(value)? {
            serde_yaml::Value::String(value) => Ok(value),
            _ => Err("Frontmatter keys must be strings.".to_string()),
        },
    }
}

fn tagged_set_to_serde(
    entries: Vec<(TaggedYamlNode<'_>, TaggedYamlNode<'_>)>,
) -> Result<serde_yaml::Value, String> {
    let mut converted = serde_yaml::Mapping::new();
    for (key, value) in entries {
        if tagged_saphyr_to_serde(value)? != serde_yaml::Value::Null {
            return Err("Set items must all have null values.".to_string());
        }
        let key = serde_yaml::Value::String(tagged_mapping_key_to_string(key)?);
        if converted.contains_key(&key) {
            return Err("Frontmatter mapping keys must be unique.".to_string());
        }
        converted.insert(key, serde_yaml::Value::Null);
    }
    Ok(serde_yaml::Value::Mapping(converted))
}

fn tagged_pairs_to_serde(
    values: Vec<TaggedYamlNode<'_>>,
    ordered: bool,
) -> Result<serde_yaml::Value, String> {
    let mut converted = Vec::with_capacity(values.len());
    let mut seen = BTreeSet::new();

    for value in values {
        let (key, value) = match value {
            TaggedYamlNode::Mapping(mut entries, _) if entries.len() <= 1 => entries
                .pop()
                .map(|(key, value)| (key, Some(value)))
                .unwrap_or((TaggedYamlNode::BadValue, None)),
            TaggedYamlNode::Mapping(_, _) => {
                return Err("Each pair must have its own sequence indicator.".to_string());
            }
            key => (key, None),
        };
        let key = tagged_mapping_key_to_string(key)?;
        if ordered && !seen.insert(key.clone()) {
            return Err("Ordered maps must not include duplicate keys.".to_string());
        }
        let value = value
            .map(tagged_saphyr_to_serde)
            .transpose()?
            .unwrap_or(serde_yaml::Value::Null);
        let mut pair = serde_yaml::Mapping::new();
        pair.insert(serde_yaml::Value::String(key), value);
        converted.push(serde_yaml::Value::Mapping(pair));
    }

    Ok(serde_yaml::Value::Sequence(converted))
}

fn tagged_scalar_to_serde(
    value: Cow<'_, str>,
    style: ScalarStyle,
    tag: Option<&Tag>,
) -> Result<serde_yaml::Value, String> {
    let Some(tag) = tag else {
        return if style == ScalarStyle::Plain {
            resolve_implicit_scalar(value)
        } else {
            Ok(serde_yaml::Value::String(value.into_owned()))
        };
    };

    if !tag.is_yaml_core_schema() {
        return Ok(wrap_custom_yaml_tag(
            tag,
            serde_yaml::Value::String(value.into_owned()),
        ));
    }

    match tag.suffix.as_str() {
        "str" => Ok(serde_yaml::Value::String(value.into_owned())),
        "int" => resolve_explicit_integer(&value),
        "float" if EXPLICIT_FLOAT_PATTERN.is_match(&value) => value
            .parse::<f64>()
            .ok()
            .or_else(|| match value.as_ref() {
                ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => Some(f64::INFINITY),
                "-.inf" | "-.Inf" | "-.INF" => Some(f64::NEG_INFINITY),
                ".nan" | ".NaN" | ".NAN" => Some(f64::NAN),
                _ => None,
            })
            .map(serde_yaml::Number::from)
            .map(serde_yaml::Value::Number)
            .ok_or_else(invalid_explicit_yaml_tag),
        "bool" => match value.as_ref() {
            "true" | "True" | "TRUE" => Ok(serde_yaml::Value::Bool(true)),
            "false" | "False" | "FALSE" => Ok(serde_yaml::Value::Bool(false)),
            _ => Err(invalid_explicit_yaml_tag()),
        },
        "null" if matches!(value.as_ref(), "" | "~" | "null" | "Null" | "NULL") => {
            Ok(serde_yaml::Value::Null)
        }
        "timestamp" if TIMESTAMP_PATTERN.is_match(&value) => {
            Ok(serde_yaml::Value::String(value.into_owned()))
        }
        "binary" => Ok(serde_yaml::Value::String(value.into_owned())),
        _ => Err(invalid_explicit_yaml_tag()),
    }
}

fn resolve_implicit_scalar(value: Cow<'_, str>) -> Result<serde_yaml::Value, String> {
    if is_core_prefixed_integer(&value) {
        resolve_explicit_integer(&value)
    } else {
        scalar_to_serde(Scalar::parse_from_cow(value))
    }
}

fn is_core_prefixed_integer(value: &str) -> bool {
    value.strip_prefix("0o").is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| matches!(byte, b'0'..=b'7'))
    }) || value.strip_prefix("0x").is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn scalar_to_serde(value: Scalar<'_>) -> Result<serde_yaml::Value, String> {
    match value {
        Scalar::Null => Ok(serde_yaml::Value::Null),
        Scalar::Boolean(value) => Ok(serde_yaml::Value::Bool(value)),
        Scalar::Integer(value) => Ok(serde_yaml::Value::Number(value.into())),
        Scalar::FloatingPoint(value) => Ok(serde_yaml::Value::Number(serde_yaml::Number::from(
            value.into_inner(),
        ))),
        Scalar::String(value) => Ok(serde_yaml::Value::String(value.into_owned())),
    }
}

fn resolve_explicit_integer(value: &str) -> Result<serde_yaml::Value, String> {
    let (digits, radix) = if let Some(digits) = value.strip_prefix("0o") {
        (digits, 8)
    } else if let Some(digits) = value.strip_prefix("0x") {
        (digits, 16)
    } else {
        let digits = value.strip_prefix(['-', '+']).unwrap_or(value);
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid_explicit_yaml_tag());
        }
        if let Ok(integer) = value.parse::<i64>() {
            return Ok(serde_yaml::Value::Number(integer.into()));
        }
        return value
            .parse::<f64>()
            .ok()
            .map(serde_yaml::Number::from)
            .map(serde_yaml::Value::Number)
            .ok_or_else(invalid_explicit_yaml_tag);
    };

    if digits.is_empty() || !digits.bytes().all(|byte| char::from(byte).is_digit(radix)) {
        return Err(invalid_explicit_yaml_tag());
    }
    if let Ok(integer) = i64::from_str_radix(digits, radix) {
        return Ok(serde_yaml::Value::Number(integer.into()));
    }
    let number = digits.bytes().try_fold(0.0, |number, byte| {
        char::from(byte)
            .to_digit(radix)
            .map(|digit| number * f64::from(radix) + f64::from(digit))
    });
    number
        .map(serde_yaml::Number::from)
        .map(serde_yaml::Value::Number)
        .ok_or_else(invalid_explicit_yaml_tag)
}

fn wrap_custom_yaml_tag(tag: &Tag, value: serde_yaml::Value) -> serde_yaml::Value {
    let name = if tag.handle == "!" {
        format!("!{}", tag.suffix)
    } else if tag.handle.is_empty() {
        tag.suffix.clone()
    } else {
        format!("{}{}", tag.handle, tag.suffix)
    };
    let name = if name.starts_with('!') {
        name
    } else {
        format!("!{name}")
    };
    let mut wrapped = serde_yaml::Mapping::new();
    wrapped.insert(serde_yaml::Value::String(name), value);
    serde_yaml::Value::Mapping(wrapped)
}

fn invalid_explicit_yaml_tag() -> String {
    "Frontmatter contains an invalid explicit YAML tag value.".to_string()
}

fn has_only_string_mapping_keys(value: &serde_yaml::Value) -> bool {
    match value {
        serde_yaml::Value::Mapping(mapping) => mapping.iter().all(|(key, value)| {
            matches!(key, serde_yaml::Value::String(_)) && has_only_string_mapping_keys(value)
        }),
        serde_yaml::Value::Sequence(sequence) => sequence.iter().all(has_only_string_mapping_keys),
        serde_yaml::Value::Tagged(tagged) => has_only_string_mapping_keys(&tagged.value),
        _ => true,
    }
}

fn contains_non_finite_number(value: &serde_yaml::Value) -> bool {
    match value {
        serde_yaml::Value::Number(number) => {
            number.as_f64().is_some_and(|number| !number.is_finite())
        }
        serde_yaml::Value::Sequence(sequence) => sequence.iter().any(contains_non_finite_number),
        serde_yaml::Value::Mapping(mapping) => mapping.iter().any(|(key, value)| {
            contains_non_finite_number(key) || contains_non_finite_number(value)
        }),
        serde_yaml::Value::Tagged(tagged) => contains_non_finite_number(&tagged.value),
        _ => false,
    }
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

    for (line_index, (line, link_line)) in split_lines_inclusive(raw)
        .into_iter()
        .zip(split_lines_inclusive(&link_searchable))
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
    let label_ends = matching_link_label_ends(line);
    let mut links = Vec::new();
    let mut cursor = 0;
    let mut source_byte_position = 0;
    let mut source_utf16_position = 0;

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
        let Some(close_bracket) = label_ends.get(&open_bracket).copied() else {
            cursor = open_bracket + 1;
            continue;
        };
        if !line[close_bracket + 1..].starts_with('(') {
            cursor = close_bracket + 1;
            continue;
        }
        if link_label_contains_link(
            line,
            source_line,
            open_bracket + 1,
            close_bracket,
            &label_ends,
        ) {
            cursor = open_bracket + 1;
            continue;
        }
        let target_start = close_bracket + 2;
        let Some((parsed_target_start, target_end, close_paren)) =
            parse_link_destination(source_line, target_start)
        else {
            cursor = close_bracket + 1;
            continue;
        };
        let target_raw = source_line[parsed_target_start..target_end].to_string();
        let text = source_line[open_bracket + 1..close_bracket]
            .trim_matches(is_ecmascript_whitespace)
            .to_string();
        advance_utf16_position(
            source_line,
            &mut source_byte_position,
            &mut source_utf16_position,
            open_bracket,
        );
        let start_utf16 = source_utf16_position;
        advance_utf16_position(
            source_line,
            &mut source_byte_position,
            &mut source_utf16_position,
            close_paren + 1,
        );
        let end_utf16 = source_utf16_position;

        links.push(Link {
            source_concept_id: source_concept_id.to_string(),
            target_raw: target_raw.clone(),
            text: if text.is_empty() { None } else { Some(text) },
            kind: classify_link_target(&target_raw),
            resolved: false,
            location: SourceRange {
                start: SourceLocation {
                    line: line_number,
                    column: start_utf16 + 1,
                    offset: absolute_line_offset + start_utf16,
                },
                end: Some(SourceLocation {
                    line: line_number,
                    column: end_utf16 + 1,
                    offset: absolute_line_offset + end_utf16,
                }),
            },
        });
        cursor = close_paren + 1;
    }

    links
}

fn advance_utf16_position(
    source: &str,
    byte_position: &mut usize,
    utf16_position: &mut usize,
    target_byte_position: usize,
) {
    debug_assert!(target_byte_position >= *byte_position);
    *utf16_position += utf16_len(&source[*byte_position..target_byte_position]);
    *byte_position = target_byte_position;
}

fn parse_link_destination(line: &str, target_start: usize) -> Option<(usize, usize, usize)> {
    let bytes = line.as_bytes();
    let mut destination_start = target_start;
    while bytes
        .get(destination_start)
        .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
    {
        destination_start += 1;
    }

    if destination_start > target_start
        && bytes
            .get(destination_start)
            .is_some_and(|byte| matches!(*byte, b')' | b'\'' | b'"' | b'('))
    {
        return parse_link_destination_tail(
            line,
            target_start,
            destination_start,
            destination_start,
        );
    }

    if bytes.get(destination_start) == Some(&b'<') {
        let mut cursor = destination_start + 1;
        while cursor < bytes.len() {
            match bytes[cursor] {
                b'<' if !is_escaped_delimiter(bytes, cursor) => return None,
                b'>' if !is_escaped_delimiter(bytes, cursor) => {
                    return parse_link_destination_tail(
                        line,
                        cursor + 1,
                        destination_start + 1,
                        cursor,
                    );
                }
                _ => cursor += 1,
            }
        }
        return None;
    }

    let mut depth = 0;
    let mut cursor = destination_start;

    while cursor < bytes.len() {
        let character = line[cursor..].chars().next()?;
        if character == '(' && !is_escaped_delimiter(bytes, cursor) {
            depth += 1;
            if depth > MAX_LINK_DESTINATION_NESTING {
                return None;
            }
        } else if character == ')' && !is_escaped_delimiter(bytes, cursor) {
            if depth == 0 {
                return Some((destination_start, cursor, cursor));
            }
            depth -= 1;
        } else if is_ecmascript_whitespace(character) {
            if depth != 0 {
                return None;
            }
            return parse_link_destination_tail(line, cursor, destination_start, cursor);
        }
        cursor += character.len_utf8();
    }

    None
}

fn parse_link_destination_tail(
    line: &str,
    tail_start: usize,
    target_start: usize,
    target_end: usize,
) -> Option<(usize, usize, usize)> {
    let bytes = line.as_bytes();
    let mut cursor = tail_start;
    while bytes
        .get(cursor)
        .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
    {
        cursor += 1;
    }
    let has_title_separator = cursor > tail_start;
    if bytes.get(cursor) == Some(&b')') {
        return Some((target_start, target_end, cursor));
    }
    if !has_title_separator {
        return None;
    }

    let quote = *bytes.get(cursor)?;
    if !matches!(quote, b'\'' | b'"' | b'(') {
        return None;
    }
    let closing_quote = if quote == b'(' { b')' } else { quote };

    cursor += 1;
    while cursor < bytes.len() {
        if bytes[cursor] == closing_quote && !is_escaped_delimiter(bytes, cursor) {
            let mut closing_paren = cursor + 1;
            while bytes
                .get(closing_paren)
                .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
            {
                closing_paren += 1;
            }
            return (bytes.get(closing_paren) == Some(&b')')).then_some((
                target_start,
                target_end,
                closing_paren,
            ));
        }
        cursor += 1;
    }

    None
}

fn matching_link_label_ends(value: &str) -> BTreeMap<usize, usize> {
    let bytes = value.as_bytes();
    let mut ends = BTreeMap::new();
    let mut stack = Vec::new();
    for cursor in 0..bytes.len() {
        match bytes[cursor] {
            b'[' if !is_escaped_delimiter(bytes, cursor) => stack.push(cursor),
            b']' if !is_escaped_delimiter(bytes, cursor) => {
                if let Some(start) = stack.pop() {
                    ends.insert(start, cursor);
                }
            }
            _ => {}
        }
    }
    ends
}

fn link_label_contains_link(
    value: &str,
    source_value: &str,
    start: usize,
    end: usize,
    label_ends: &BTreeMap<usize, usize>,
) -> bool {
    let bytes = value.as_bytes();
    let mut cursor = start;

    while cursor < end {
        let Some(nested_relative) = bytes[cursor..end].iter().position(|byte| *byte == b'[') else {
            return false;
        };
        let nested_start = cursor + nested_relative;
        if is_escaped_delimiter(bytes, nested_start)
            || (nested_start > 0
                && bytes[nested_start - 1] == b'!'
                && !is_escaped_delimiter(bytes, nested_start - 1))
        {
            cursor = nested_start + 1;
            continue;
        }

        if let Some(nested_end) = label_ends.get(&nested_start).copied()
            && nested_end < end
            && value[nested_end + 1..].starts_with('(')
            && parse_link_destination(source_value, nested_end + 2)
                .is_some_and(|(_, _, closing_paren)| closing_paren < end)
        {
            return true;
        }
        cursor = nested_start + 1;
    }

    false
}

fn classify_link_target(target: &str) -> LinkKind {
    let target = unescape_markdown_destination(target);
    if target.trim_matches(is_ecmascript_whitespace).is_empty() {
        LinkKind::Unknown
    } else if target.starts_with('#') {
        LinkKind::Anchor
    } else if target.starts_with("//") || looks_like_scheme(&target) {
        LinkKind::External
    } else {
        LinkKind::Internal
    }
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

    for line in split_lines_inclusive(markdown) {
        let line = line.trim_end_matches(['\r', '\n']);
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
        let stripped = heading_text
            .replace('`', "")
            .replace(['*', '_', '~', '>', '-'], " ");
        text.push_str(&stripped);
        text.push(' ');
    }

    text.split(is_ecmascript_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_inline_links(markdown: &str) -> String {
    let bytes = markdown.as_bytes();
    let label_ends = matching_link_label_ends(markdown);
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
        let Some(close_bracket) = label_ends.get(&open).copied() else {
            cursor = open + 1;
            continue;
        };
        if !markdown[close_bracket + 1..].starts_with('(') {
            cursor = close_bracket + 1;
            continue;
        }
        if link_label_contains_link(markdown, markdown, open + 1, close_bracket, &label_ends) {
            cursor = open + 1;
            continue;
        }
        let Some((_, _, close_paren)) = parse_link_destination(markdown, close_bracket + 2) else {
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

    for line in split_lines_inclusive(markdown) {
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
    let runs = backtick_runs(bytes);
    let next_same_length = next_backtick_runs_by_length(&runs);
    let mut run_index = 0;

    while run_index < runs.len() {
        let opener = runs[run_index];
        let opener_start = opener.start + usize::from(opener.escaped);
        let Some(closing_index) = next_same_length[run_index] else {
            run_index += 1;
            continue;
        };
        let closing = runs[closing_index];
        let closing_end = closing.start + closing.length;
        for byte in &mut masked[opener_start..closing_end] {
            if !matches!(*byte, b'\r' | b'\n') {
                *byte = b' ';
            }
        }
        run_index = closing_index + 1;
    }

    String::from_utf8(masked).expect("masking Markdown preserves valid UTF-8")
}

#[derive(Debug, Clone, Copy)]
struct BacktickRun {
    start: usize,
    length: usize,
    escaped: bool,
}

fn backtick_runs(value: &[u8]) -> Vec<BacktickRun> {
    let mut runs = Vec::new();
    let mut cursor = 0;
    while cursor < value.len() {
        let Some(relative_start) = value[cursor..].iter().position(|byte| *byte == b'`') else {
            break;
        };
        let start = cursor + relative_start;
        let length = value[start..]
            .iter()
            .take_while(|byte| **byte == b'`')
            .count();
        runs.push(BacktickRun {
            start,
            length,
            escaped: is_escaped_delimiter(value, start),
        });
        cursor = start + length;
    }
    runs
}

fn next_backtick_runs_by_length(runs: &[BacktickRun]) -> Vec<Option<usize>> {
    let mut next_same_length = vec![None; runs.len()];
    let mut next_by_length = BTreeMap::new();
    for (index, run) in runs.iter().enumerate().rev() {
        let opener_length = run.length - usize::from(run.escaped);
        if opener_length > 0 {
            next_same_length[index] = next_by_length.get(&opener_length).copied();
        }
        next_by_length.insert(run.length, index);
    }
    next_same_length
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

fn is_escaped_delimiter(value: &[u8], index: usize) -> bool {
    value[..index]
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\\')
        .count()
        % 2
        == 1
}

fn is_ecmascript_whitespace(character: char) -> bool {
    // ECMAScript's `\s`/String#trim set differs from Unicode White_Space at
    // exactly these two code points: it includes BOM and excludes NEL.
    character == '\u{feff}' || (character.is_whitespace() && character != '\u{0085}')
}

fn slugify_heading(title: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;

    for character in title
        .trim_matches(is_ecmascript_whitespace)
        .to_lowercase()
        .chars()
    {
        if character.is_alphanumeric() {
            slug.push(character);
            previous_dash = false;
        } else if (is_ecmascript_whitespace(character) || character == '-')
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
    let bytes = &content.as_bytes()[..offset];
    let mut line = 1;
    let mut cursor = 0;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\r' => {
                line += 1;
                cursor += usize::from(bytes.get(cursor + 1) == Some(&b'\n')) + 1;
            }
            b'\n' => {
                line += 1;
                cursor += 1;
            }
            _ => cursor += 1,
        }
    }
    line
}

fn split_lines_inclusive(value: &str) -> Vec<&str> {
    let bytes = value.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut cursor = 0;

    while cursor < bytes.len() {
        let end = match bytes[cursor] {
            b'\r' if bytes.get(cursor + 1) == Some(&b'\n') => cursor + 2,
            b'\r' | b'\n' => cursor + 1,
            _ => {
                cursor += 1;
                continue;
            }
        };
        lines.push(&value[start..end]);
        start = end;
        cursor = end;
    }

    if start < value.len() {
        lines.push(&value[start..]);
    }
    lines
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
    fn preserves_unicode_whitespace_in_atx_heading_content() {
        let parsed =
            parse_markdown_document("concept.md", "# \u{a0}Padded\u{a0}\n# हिंदी\n", "concept");

        assert_eq!(parsed.body.headings[0].title, "\u{a0}Padded\u{a0}");
        assert_eq!(parsed.body.headings[0].slug, "padded");
        assert_eq!(parsed.body.headings[1].title, "हिंदी");
        assert_eq!(parsed.body.headings[1].slug, "हिंदी");
    }

    #[test]
    fn matches_ecmascript_whitespace_semantics() {
        assert_eq!(
            plain_text("alpha\u{feff}beta gamma\u{0085}delta"),
            "alpha beta gamma\u{0085}delta"
        );
        assert_eq!(slugify_heading("alpha\u{feff}beta"), "alpha-beta");
        assert_eq!(slugify_heading("alpha\u{0085}beta"), "alphabeta");
        assert_eq!(classify_link_target("\u{feff}"), LinkKind::Unknown);
        assert_eq!(classify_link_target("\u{0085}"), LinkKind::Internal);

        let labels = parse_markdown_document(
            "concept.md",
            "[\u{feff}BOM\u{feff}](bom.md) [\u{0085}NEL\u{0085}](nel.md)",
            "concept",
        );
        assert_eq!(labels.links[0].text.as_deref(), Some("BOM"));
        assert_eq!(labels.links[1].text.as_deref(), Some("\u{0085}NEL\u{0085}"));

        let headings = parse_markdown_document(
            "concept.md",
            "# alpha\u{2028}beta\n# gamma\u{2029}delta\n",
            "concept",
        );
        assert_eq!(
            headings
                .body
                .headings
                .iter()
                .map(|heading| (heading.title.as_str(), heading.slug.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("alpha\u{2028}beta", "alpha-beta"),
                ("gamma\u{2029}delta", "gamma-delta")
            ]
        );

        let parsed = parse_markdown_document(
            "concept.md",
            "[BOM](<\u{feff}>) [NEL](<\u{0085}>) [BOM tail](target\u{feff}) [NEL target](target\u{0085})",
            "concept",
        );
        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| (link.text.as_deref(), link.kind))
                .collect::<Vec<_>>(),
            vec![
                (Some("BOM"), LinkKind::Unknown),
                (Some("NEL"), LinkKind::Internal),
                (Some("NEL target"), LinkKind::Internal),
            ]
        );
    }

    #[test]
    fn parses_frontmatter_and_locations_with_carriage_return_line_endings() {
        let parsed = parse_markdown_document(
            "concept.md",
            "---\rtype: Note\r---\r# Heading\r[Target](target.md)\r",
            "concept",
        );

        assert_eq!(
            parsed
                .frontmatter
                .as_ref()
                .and_then(|frontmatter| frontmatter.get("type"))
                .and_then(serde_yaml::Value::as_str),
            Some("Note")
        );
        assert_eq!(parsed.body.headings[0].location.start.line, 4);
        assert_eq!(parsed.body.headings[0].location.start.column, 1);
        assert_eq!(parsed.links[0].location.start.line, 5);
        assert_eq!(parsed.links[0].location.start.column, 1);
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
    fn rejects_null_frontmatter() {
        for content in ["---\n---\n# Empty\n", "---\n~\n---\n# Null\n"] {
            let parsed = parse_markdown_document("bad.md", content, "bad");

            assert_eq!(parsed.frontmatter, None);
            assert_eq!(parsed.diagnostics[0].code, "spec/invalid-frontmatter");
            assert_eq!(
                parsed.diagnostics[0].message,
                "Frontmatter must be a YAML mapping."
            );
        }
    }

    #[test]
    fn rejects_non_string_frontmatter_keys() {
        for entry in [
            "1: one",
            "[a, b]: sequence",
            "metadata: {1: one}",
            "metadata: !!omap [{1: one}]",
        ] {
            let content = format!("---\n{entry}\n---\n# Bad\n");
            let parsed = parse_markdown_document("bad.md", content, "bad");

            assert_eq!(parsed.frontmatter, None);
            assert_eq!(parsed.diagnostics[0].code, "spec/invalid-frontmatter");
            assert_eq!(
                parsed.diagnostics[0].message,
                "Frontmatter keys must be strings."
            );
        }
    }

    #[test]
    fn rejects_recursive_yaml_aliases() {
        let parsed = parse_markdown_document(
            "bad.md",
            "---\nmetadata: &metadata { self: *metadata }\n---\n# Bad\n",
            "bad",
        );

        assert!(parsed.frontmatter.is_none());
        assert_eq!(parsed.diagnostics[0].code, "spec/invalid-frontmatter");
    }

    #[test]
    fn rejects_non_finite_frontmatter_numbers() {
        for value in [".nan", ".inf", "-.inf", "1e400"] {
            let content = format!("---\nmetadata: [{value}]\n---\n# Bad\n");
            let parsed = parse_markdown_document("bad.md", content, "bad");

            assert!(parsed.frontmatter.is_none());
            assert_eq!(parsed.diagnostics[0].code, "spec/invalid-frontmatter");
            assert_eq!(
                parsed.diagnostics[0].message,
                "Frontmatter numbers must be finite."
            );
        }
    }

    #[test]
    fn matches_yaml_1_2_implicit_scalar_resolution() {
        let parsed = parse_markdown_document(
            "scalars.md",
            "---\nzero: 00\ndecimal: 012\nbinary_like: 0b101\noversized: 18446744073709551616\nlarge_hex: 0x8000000000000000\nlarge_oct: 0o7777777777777777777777\nnel: \u{0085}\nseparator: \u{2028}\nquoted: \"x:\ty\"\nmultiline: \"x\n  z:\tw\"\nliteral: |\n  x:\ty\ntabbed:\tvalue\n---\n",
            "scalars",
        );
        let frontmatter = parsed.frontmatter.as_ref().unwrap();

        assert!(parsed.diagnostics.is_empty());
        assert_eq!(
            frontmatter.get("zero").and_then(serde_yaml::Value::as_i64),
            Some(0)
        );
        assert_eq!(
            frontmatter
                .get("decimal")
                .and_then(serde_yaml::Value::as_i64),
            Some(12)
        );
        assert_eq!(
            frontmatter
                .get("binary_like")
                .and_then(serde_yaml::Value::as_str),
            Some("0b101")
        );
        assert_eq!(
            frontmatter
                .get("oversized")
                .and_then(serde_yaml::Value::as_f64),
            Some(18_446_744_073_709_552_000.0)
        );
        assert_eq!(
            frontmatter
                .get("large_hex")
                .and_then(serde_yaml::Value::as_f64),
            Some(9_223_372_036_854_776_000.0)
        );
        assert_eq!(
            frontmatter
                .get("large_oct")
                .and_then(serde_yaml::Value::as_f64),
            Some(73_786_976_294_838_210_000.0)
        );
        assert_eq!(
            frontmatter.get("nel").and_then(serde_yaml::Value::as_str),
            Some("\u{0085}")
        );
        assert_eq!(
            frontmatter
                .get("separator")
                .and_then(serde_yaml::Value::as_str),
            Some("\u{2028}")
        );
        assert_eq!(
            frontmatter
                .get("tabbed")
                .and_then(serde_yaml::Value::as_str),
            Some("value")
        );
        assert_eq!(
            frontmatter
                .get("quoted")
                .and_then(serde_yaml::Value::as_str),
            Some("x:\ty")
        );
        assert_eq!(
            frontmatter
                .get("literal")
                .and_then(serde_yaml::Value::as_str),
            Some("x:\ty\n")
        );
        assert!(
            frontmatter
                .get("multiline")
                .and_then(serde_yaml::Value::as_str)
                .is_some_and(|value| value.contains("z:\tw"))
        );
    }

    #[test]
    fn rejects_duplicate_yaml_keys_after_legacy_numeric_overflow() {
        for frontmatter in [
            "huge: 18446744073709551616\na: 1\na: 2",
            "huge: 18446744073709551616\nnested: {a: 1, a: 2}",
        ] {
            let content = format!("---\n{frontmatter}\n---\n");
            let parsed = parse_markdown_document("duplicate.md", content, "duplicate");

            assert!(parsed.frontmatter.is_none());
            assert_eq!(parsed.diagnostics[0].code, "spec/invalid-frontmatter");
        }
    }

    #[test]
    fn serializes_yaml_tags_to_json_compatible_values() {
        let parsed = parse_markdown_document(
            "tagged.md",
            "---\ntype: Note\nmetadata:\n  ordered: !!omap [{a: 1}, {b: 2}]\n  tagged_ordered: !!omap [{a: !!timestamp 2020-01-01}, {b: !!binary SGVsbG8=}]\n  pairs: !!pairs [{a: 1}, {b: 2}]\n  set: !!set {a: null, b: null}\n  binary: !!binary SGVsbG8=\n  timestamp: !!timestamp 2020-01-01T12:34:56Z\n  custom: !custom value\n  custom_number: !custom 42\n  uri_custom: !<tag:example.com,2026:foo> value\n  encoded_custom: !<tag:example.com,2026:foo%2Fbar> value\n  non_specific: ! value\n---\n# Tagged\n",
            "tagged",
        );

        assert!(parsed.diagnostics.is_empty());
        assert_eq!(
            serde_json::to_value(parsed.frontmatter).unwrap(),
            serde_json::json!({
                "type": "Note",
                "metadata": {
                    "ordered": [{"a": 1}, {"b": 2}],
                    "tagged_ordered": [{"a": "2020-01-01"}, {"b": "SGVsbG8="}],
                    "pairs": [{"a": 1}, {"b": 2}],
                    "set": {"a": null, "b": null},
                    "binary": "SGVsbG8=",
                    "timestamp": "2020-01-01T12:34:56Z",
                    "custom": {"!custom": "value"},
                    "custom_number": {"!custom": "42"},
                    "uri_custom": {"!tag:example.com,2026:foo": "value"},
                    "encoded_custom": {"!tag:example.com,2026:foo/bar": "value"},
                    "non_specific": {"!": "value"}
                }
            })
        );
    }

    #[test]
    fn normalizes_and_validates_yaml_collection_tags() {
        let parsed = parse_markdown_document(
            "collections.md",
            "---\nmetadata:\n  ordered: !!omap [a, {b: 2}]\n  pairs: !!pairs [a, {b: 2}]\n  set: !!set {a: null, b: null}\n---\n",
            "collections",
        );
        assert_eq!(
            serde_json::to_value(parsed.frontmatter).unwrap(),
            serde_json::json!({
                "metadata": {
                    "ordered": [{"a": null}, {"b": 2}],
                    "pairs": [{"a": null}, {"b": 2}],
                    "set": {"a": null, "b": null}
                }
            })
        );

        for value in [
            "!!set {a: 1}",
            "!!omap [{a: 1, b: 2}]",
            "!!omap [{a: 1}, {a: 2}]",
            "!!pairs [{a: 1, b: 2}]",
        ] {
            let content = format!("---\nmetadata: {value}\n---\n");
            let parsed = parse_markdown_document("bad.md", content, "bad");
            assert!(parsed.frontmatter.is_none(), "accepted {value}");
            assert_eq!(parsed.diagnostics[0].code, "spec/invalid-frontmatter");
        }
    }

    #[test]
    fn rejects_invalid_explicit_yaml_tag_values() {
        for value in [
            "!!null x",
            "!!bool yes",
            "!!int abc",
            "!!float abc",
            "!!float 42",
            "!!set [x, y]",
            "!!str [x, y]",
            "!!unknown x",
        ] {
            let content = format!("---\nmetadata: {value}\n---\n# Bad\n");
            let parsed = parse_markdown_document("bad.md", content, "bad");

            assert!(parsed.frontmatter.is_none());
            assert_eq!(parsed.diagnostics[0].code, "spec/invalid-frontmatter");
        }
    }

    #[test]
    fn rejects_custom_tagged_root_mappings() {
        let parsed =
            parse_markdown_document("bad.md", "---\n!custom {type: Note}\n---\n# Bad\n", "bad");

        assert!(parsed.frontmatter.is_none());
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
            "# Visible\n`[single](hidden-single.md)`\n``before\n[multiline](hidden-multiline.md)\nafter``\n\\`[literal](visible.md)\n[Also visible](also-visible.md)\n[Use `code`](code-label.md)\n[Version](docs/`v1`.md)\n",
            "note",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.target_raw.as_str())
                .collect::<Vec<_>>(),
            vec![
                "visible.md",
                "also-visible.md",
                "code-label.md",
                "docs/`v1`.md"
            ]
        );
        assert_eq!(
            parsed.links.get(2).and_then(|link| link.text.as_deref()),
            Some("Use `code`")
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
    fn bounds_nested_parentheses_in_link_destinations() {
        let accepted = format!("({}target{})", "(".repeat(63), ")".repeat(63));
        let rejected = format!("({}target{})", "(".repeat(64), ")".repeat(64));
        let parsed = parse_markdown_document(
            "concept.md",
            format!("[Accepted]({accepted})\n[Rejected]({rejected})\n"),
            "concept",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .filter_map(|link| link.text.as_deref())
                .collect::<Vec<_>>(),
            vec!["Accepted"]
        );
    }

    #[test]
    fn parses_nested_and_empty_link_labels() {
        let parsed = parse_markdown_document(
            "concept.md",
            "[See [details]](details.md) [](empty.md) [Escaped \\] label](escaped.md)\n",
            "concept",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| (link.target_raw.as_str(), link.text.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("details.md", Some("See [details]")),
                ("empty.md", None),
                ("escaped.md", Some("Escaped \\] label"))
            ]
        );
        assert_eq!(parsed.body.text, "See [details] Escaped \\] label");
    }

    #[test]
    fn finds_valid_links_after_unmatched_opening_brackets() {
        let parsed =
            parse_markdown_document("concept.md", "[Unmatched [Valid](valid.md)\n", "concept");

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.target_raw.as_str())
                .collect::<Vec<_>>(),
            vec!["valid.md"]
        );
    }

    #[test]
    fn keeps_inner_links_from_becoming_nested_outer_links() {
        let parsed = parse_markdown_document(
            "concept.md",
            "[Outer [Inner](inner.md)](outer.md) [Image ![Alt](image.png)](image-outer.md)\n",
            "concept",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.target_raw.as_str())
                .collect::<Vec<_>>(),
            vec!["inner.md", "image-outer.md"]
        );
    }

    #[test]
    fn parses_empty_and_enclosed_destinations_with_titles() {
        let parsed = parse_markdown_document(
            "concept.md",
            "[Empty]() [Spaced]( ) [Blank angle](< >) [Angle](<docs/a b.md> \"Reference\") [Title](docs/title.md (Reference))\n",
            "concept",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| (link.target_raw.as_str(), link.kind))
                .collect::<Vec<_>>(),
            vec![
                ("", LinkKind::Unknown),
                ("", LinkKind::Unknown),
                (" ", LinkKind::Unknown),
                ("docs/a b.md", LinkKind::Internal),
                ("docs/title.md", LinkKind::Internal)
            ]
        );
        assert_eq!(parsed.body.text, "Empty Spaced Blank angle Angle Title");
    }

    #[test]
    fn requires_whitespace_before_an_enclosed_destination_title() {
        let parsed = parse_markdown_document(
            "concept.md",
            "[Invalid](<docs/invalid.md>\"Title\") [Valid](<docs/valid.md> \"Title\")\n",
            "concept",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.target_raw.as_str())
                .collect::<Vec<_>>(),
            vec!["docs/valid.md"]
        );
    }

    #[test]
    fn allows_spaces_around_destinations_and_titles() {
        let parsed = parse_markdown_document(
            "concept.md",
            "[Leading](   docs/leading.md) [Angle](  <docs/a b.md> ) [Title]( docs/title.md \"Title\"  )\n",
            "concept",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.target_raw.as_str())
                .collect::<Vec<_>>(),
            vec!["docs/leading.md", "docs/a b.md", "docs/title.md"]
        );
    }

    #[test]
    fn classifies_links_after_applying_markdown_backslash_escapes() {
        let parsed = parse_markdown_document(
            "concept.md",
            r"[External](https\://example.com) [Anchor](\#details) [Internal](docs/item.md)",
            "concept",
        );

        assert_eq!(
            parsed
                .links
                .iter()
                .map(|link| link.kind)
                .collect::<Vec<_>>(),
            vec![LinkKind::External, LinkKind::Anchor, LinkKind::Internal]
        );
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
    fn removes_unmatched_backticks_without_splitting_plain_text() {
        let parsed =
            parse_markdown_document("note.md", "foo`bar \\`[Visible](visible.md)`\n", "note");

        assert_eq!(parsed.body.text, "foobar \\Visible");
        assert_eq!(parsed.links.len(), 1);
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
    fn parses_many_links_without_rescanning_line_prefixes() {
        let count = 4_000;
        let content = "[Target](target.md) ".repeat(count);
        let started = std::time::Instant::now();

        let parsed = parse_markdown_document("many.md", content, "many");

        assert_eq!(parsed.links.len(), count);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "single-line link parsing took {:?}",
            started.elapsed()
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
