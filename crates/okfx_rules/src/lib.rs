use okfx_core::find_representative_cycles;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr};

pub const CRATE_NAME: &str = "okfx_rules";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Advice,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleLevel {
    Off,
    Error,
    Warning,
    Advice,
    Info,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    #[default]
    Internal,
    External,
    Anchor,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    pub path: Option<String>,
    pub concept_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConceptRuleInput {
    pub id: String,
    pub path: String,
    pub concept_type: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub body_text: String,
    pub resource: Vec<String>,
    pub tags: Vec<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub frontmatter_raw: Option<String>,
    #[serde(default)]
    pub has_frontmatter: Option<bool>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub headings: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkRuleInput {
    pub source_concept_id: String,
    pub source_path: String,
    pub target_raw: String,
    #[serde(default)]
    pub target_concept_id: Option<String>,
    #[serde(default)]
    pub kind: LinkKind,
    pub resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleOptions {
    #[serde(default)]
    pub frontmatter_key_order: Vec<String>,
    #[serde(default)]
    pub resource_allow_hosts: Vec<String>,
    #[serde(default = "default_high_degree_threshold")]
    pub high_degree_threshold: usize,
    #[serde(default)]
    pub rule_levels: BTreeMap<String, RuleLevel>,
}

impl Default for RuleOptions {
    fn default() -> Self {
        Self {
            frontmatter_key_order: default_frontmatter_key_order(),
            resource_allow_hosts: Vec::new(),
            high_degree_threshold: default_high_degree_threshold(),
            rule_levels: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleInput {
    pub concepts: Vec<ConceptRuleInput>,
    pub links: Vec<LinkRuleInput>,
    #[serde(default)]
    pub options: RuleOptions,
}

#[derive(Debug)]
struct RuleContext<'a> {
    concepts: &'a [ConceptRuleInput],
    links: &'a [LinkRuleInput],
    options: &'a RuleOptions,
    concepts_by_id: BTreeMap<&'a str, &'a ConceptRuleInput>,
    incoming_by_concept_id: BTreeMap<&'a str, usize>,
    outgoing_by_concept_id: BTreeMap<&'a str, usize>,
    adjacency: BTreeMap<&'a str, Vec<&'a str>>,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn run_builtin_rules(input: RuleInput) -> Vec<Diagnostic> {
    let context = RuleContext::new(&input);
    let mut diagnostics = Vec::new();
    diagnostics.extend(spec_rules(&context));
    diagnostics.extend(hygiene_rules(&context));
    diagnostics.extend(graph_rules(&context));
    diagnostics.extend(style_rules(&context));
    diagnostics.extend(agent_rules(&context));
    diagnostics.extend(security_rules(&context));
    diagnostics.sort_by(|left, right| {
        severity_rank(right.severity)
            .cmp(&severity_rank(left.severity))
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.concept_id.cmp(&right.concept_id))
            .then_with(|| left.code.cmp(&right.code))
            .then_with(|| left.message.cmp(&right.message))
    });
    diagnostics
}

impl<'a> RuleContext<'a> {
    fn new(input: &'a RuleInput) -> Self {
        let concepts_by_id = input
            .concepts
            .iter()
            .map(|concept| (concept.id.as_str(), concept))
            .collect::<BTreeMap<_, _>>();
        let mut incoming_sources_by_concept_id: BTreeMap<&'a str, BTreeSet<&'a str>> =
            BTreeMap::new();
        let mut outgoing_targets_by_concept_id: BTreeMap<&'a str, BTreeSet<&'a str>> =
            BTreeMap::new();
        let mut adjacency: BTreeMap<&'a str, Vec<&'a str>> = BTreeMap::new();

        for link in &input.links {
            if link.kind != LinkKind::Internal || !link.resolved {
                continue;
            }
            let Some(target_id) = link.target_concept_id.as_deref() else {
                continue;
            };
            if !concepts_by_id.contains_key(link.source_concept_id.as_str())
                || !concepts_by_id.contains_key(target_id)
            {
                continue;
            }

            incoming_sources_by_concept_id
                .entry(target_id)
                .or_default()
                .insert(link.source_concept_id.as_str());
            outgoing_targets_by_concept_id
                .entry(link.source_concept_id.as_str())
                .or_default()
                .insert(target_id);
            adjacency
                .entry(link.source_concept_id.as_str())
                .or_default()
                .push(target_id);
        }

        let incoming_by_concept_id = incoming_sources_by_concept_id
            .into_iter()
            .map(|(id, sources)| (id, sources.len()))
            .collect();
        let outgoing_by_concept_id = outgoing_targets_by_concept_id
            .into_iter()
            .map(|(id, targets)| (id, targets.len()))
            .collect();

        for targets in adjacency.values_mut() {
            targets.sort_unstable();
            targets.dedup();
        }

        Self {
            concepts: &input.concepts,
            links: &input.links,
            options: &input.options,
            concepts_by_id,
            incoming_by_concept_id,
            outgoing_by_concept_id,
            adjacency,
        }
    }
}

fn spec_rules(context: &RuleContext<'_>) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    for concept in context.concepts {
        if concept.has_frontmatter == Some(false) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "spec/missing-frontmatter",
                Severity::Error,
                concept,
                "Concept document must include parseable YAML frontmatter.",
            );
            continue;
        }

        if concept.concept_type.trim().is_empty() {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "spec/missing-type",
                Severity::Error,
                concept,
                "Concept document must include non-empty frontmatter field \"type\".",
            );
        }

        if !is_valid_concept_path(&concept.path) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "spec/invalid-concept-path",
                Severity::Error,
                concept,
                "Concept path must be normalized, relative, and end in .md.",
            );
        }

        if is_reserved_markdown_file(&concept.path) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "spec/reserved-filename-conflict",
                Severity::Error,
                concept,
                "Concept path uses a reserved OKF filename.",
            );
        }
    }

    diagnostics
}

fn hygiene_rules(context: &RuleContext<'_>) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    for concept in context.concepts {
        if concept
            .title
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "hygiene/missing-title",
                Severity::Warning,
                concept,
                "Concept should include a title.",
            );
        }
        if concept
            .description
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "hygiene/missing-description",
                Severity::Warning,
                concept,
                "Concept should include a description.",
            );
        }
        if concept.body_text.trim().is_empty() {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "hygiene/empty-body",
                Severity::Warning,
                concept,
                "Concept body should not be empty.",
            );
        }
    }

    diagnostics.extend(duplicate_by(
        context,
        |concept| {
            concept
                .title
                .as_deref()
                .map(|title| title.trim().to_lowercase())
        },
        "hygiene/duplicate-title",
        "Concept title is duplicated.",
    ));
    diagnostics.extend(duplicate_resources(context));
    diagnostics
}

fn graph_rules(context: &RuleContext<'_>) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    for link in context
        .links
        .iter()
        .filter(|link| link.kind == LinkKind::Internal && !link.resolved)
    {
        push_link_diagnostic(
            &mut diagnostics,
            context.options,
            "graph/broken-internal-link",
            Severity::Warning,
            link,
            &format!(
                "Internal link target \"{}\" does not resolve to a concept.",
                link.target_raw
            ),
        );
    }

    for concept in context.concepts {
        let incoming = context
            .incoming_by_concept_id
            .get(concept.id.as_str())
            .copied()
            .unwrap_or_default();
        let outgoing = context
            .outgoing_by_concept_id
            .get(concept.id.as_str())
            .copied()
            .unwrap_or_default();

        if incoming == 0 && outgoing == 0 {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "graph/orphan-concept",
                Severity::Advice,
                concept,
                "Concept has no incoming or outgoing concept links.",
            );
        } else if incoming == 0 {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "graph/no-backlinks",
                Severity::Advice,
                concept,
                "Concept has no backlinks.",
            );
        }

        let total_degree = incoming + outgoing;
        if context.options.high_degree_threshold > 0
            && total_degree >= context.options.high_degree_threshold
        {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "graph/high-degree-hub",
                Severity::Advice,
                concept,
                "Concept has unusually high graph degree and may need a hub/index split.",
            );
        }
    }

    diagnostics.extend(circular_reference_diagnostics(context));
    diagnostics
}

fn style_rules(context: &RuleContext<'_>) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let key_order = configured_frontmatter_key_order(context.options);

    for concept in context.concepts {
        if !frontmatter_key_order_is_stable(concept.frontmatter_raw.as_deref(), &key_order) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "style/frontmatter-key-order",
                Severity::Warning,
                concept,
                "Frontmatter keys should use the configured stable order.",
            );
        }

        if concept
            .timestamp
            .as_deref()
            .is_some_and(|timestamp| !is_iso_timestamp(timestamp))
        {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "style/timestamp-format",
                Severity::Warning,
                concept,
                "Timestamp should be an ISO-8601 UTC timestamp.",
            );
        }

        for tag in concept.tags.iter().filter(|tag| !is_kebab_case_tag(tag)) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "style/tag-format",
                Severity::Warning,
                concept,
                &format!("Tag \"{tag}\" should be lowercase kebab-case."),
            );
        }

        if !is_file_name_format(&concept.path) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "style/file-name-format",
                Severity::Warning,
                concept,
                "Concept file path should be lowercase and URL-friendly.",
            );
        }
    }

    diagnostics
}

fn agent_rules(context: &RuleContext<'_>) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    for concept in context.concepts {
        let concept_type = concept.concept_type.to_lowercase();
        let headings = concept_headings(concept);

        if ["api", "metric", "runbook"].contains(&concept_type.as_str())
            && concept
                .owner
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
        {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "agent/missing-owner",
                Severity::Advice,
                concept,
                "Production-facing concepts should declare an owner.",
            );
        }

        if !has_heading(&headings, "summary")
            && concept
                .description
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
        {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "agent/missing-summary",
                Severity::Advice,
                concept,
                "Concept should provide a summary through description or a Summary section.",
            );
        }

        if ["api", "metric"].contains(&concept_type.as_str()) && !has_heading(&headings, "usage") {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "agent/missing-usage",
                Severity::Advice,
                concept,
                "Agent-facing API and metric concepts should include a Usage section.",
            );
        }

        if concept_type == "metric" && !links_to_type(concept, context, "table") {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "agent/metric-missing-source",
                Severity::Warning,
                concept,
                "Metric should link to at least one source table concept.",
            );
        }

        if concept_type == "runbook" && !has_heading(&headings, "symptoms") {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "agent/runbook-missing-symptoms",
                Severity::Warning,
                concept,
                "Runbook should include a Symptoms section.",
            );
        }

        if concept_type == "api" && !headings.iter().any(|heading| is_auth_heading(heading)) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "agent/api-missing-auth-notes",
                Severity::Advice,
                concept,
                "API concept should include authentication notes.",
            );
        }
    }

    diagnostics
}

fn security_rules(context: &RuleContext<'_>) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let allowed_hosts = context
        .options
        .resource_allow_hosts
        .iter()
        .map(|host| normalize_configured_host(host))
        .collect::<BTreeSet<_>>();

    for concept in context.concepts {
        let searchable_text = format!(
            "{}\n{}",
            concept.frontmatter_raw.as_deref().unwrap_or_default(),
            concept.body_text
        );
        if contains_suspicious_secret(&searchable_text) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "security/suspicious-secret",
                Severity::Error,
                concept,
                "Concept appears to contain a secret or token.",
            );
        }

        if contains_private_key(&searchable_text) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "security/private-key",
                Severity::Error,
                concept,
                "Concept appears to contain a private key.",
            );
        }

        if contains_token_looking_value(&searchable_text) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "security/token-looking-value",
                Severity::Warning,
                concept,
                "Concept appears to contain a token-looking value.",
            );
        }

        if contains_unredacted_email(&searchable_text) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "security/unredacted-email",
                Severity::Warning,
                concept,
                "Concept appears to contain an unredacted email address.",
            );
        }

        if contains_internal_url(&concept_text_without_resources(concept)) {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "security/internal-url",
                Severity::Warning,
                concept,
                "Concept contains an internal or private URL outside the resource field.",
            );
        }

        for resource in &concept.resource {
            if is_private_url(resource) {
                push_concept_diagnostic(
                    &mut diagnostics,
                    context.options,
                    "security/private-url",
                    Severity::Warning,
                    concept,
                    &format!("Resource URL \"{resource}\" points to a private or local host."),
                );
            }

            if !allowed_hosts.is_empty()
                && resource_host(resource).is_some_and(|host| !allowed_hosts.contains(&host))
            {
                push_concept_diagnostic(
                    &mut diagnostics,
                    context.options,
                    "security/non-allowlisted-resource",
                    Severity::Error,
                    concept,
                    &format!("Resource URL \"{resource}\" is outside the configured allowlist."),
                );
            }
        }
    }

    diagnostics
}

fn duplicate_by<F>(
    context: &RuleContext<'_>,
    get_value: F,
    code: &str,
    message: &str,
) -> Vec<Diagnostic>
where
    F: Fn(&ConceptRuleInput) -> Option<String>,
{
    let mut concepts_by_value: BTreeMap<String, Vec<&ConceptRuleInput>> = BTreeMap::new();
    for concept in context.concepts {
        if let Some(value) = get_value(concept).filter(|value| !value.is_empty()) {
            concepts_by_value.entry(value).or_default().push(concept);
        }
    }

    let mut diagnostics = Vec::new();
    for duplicates in concepts_by_value
        .into_values()
        .filter(|duplicates| duplicates.len() > 1)
    {
        for concept in duplicates {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                code,
                Severity::Warning,
                concept,
                message,
            );
        }
    }
    diagnostics
}

fn duplicate_resources(context: &RuleContext<'_>) -> Vec<Diagnostic> {
    let mut concepts_by_resource: BTreeMap<String, Vec<&ConceptRuleInput>> = BTreeMap::new();
    for concept in context.concepts {
        let mut seen_resources = BTreeSet::new();
        for resource in &concept.resource {
            let key = resource.trim().to_lowercase();
            if !key.is_empty() && seen_resources.insert(key.clone()) {
                concepts_by_resource.entry(key).or_default().push(concept);
            }
        }
    }

    let mut diagnostics = Vec::new();
    for duplicates in concepts_by_resource
        .into_values()
        .filter(|duplicates| duplicates.len() > 1)
    {
        for concept in duplicates {
            push_concept_diagnostic(
                &mut diagnostics,
                context.options,
                "hygiene/duplicate-resource",
                Severity::Warning,
                concept,
                "Concept resource is duplicated.",
            );
        }
    }
    diagnostics
}

fn circular_reference_diagnostics(context: &RuleContext<'_>) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let concept_ids = context
        .concepts
        .iter()
        .map(|concept| concept.id.clone())
        .collect::<BTreeSet<_>>();
    let outgoing = context
        .adjacency
        .iter()
        .map(|(source, targets)| {
            (
                (*source).to_string(),
                targets
                    .iter()
                    .map(|target| (*target).to_string())
                    .collect::<BTreeSet<_>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();

    for cycle in find_representative_cycles(&concept_ids, &outgoing) {
        let Some(concept) = context.concepts_by_id.get(cycle[0].as_str()) else {
            continue;
        };
        push_concept_diagnostic(
            &mut diagnostics,
            context.options,
            "graph/circular-reference",
            Severity::Warning,
            concept,
            &format!(
                "Circular concept reference detected: {}.",
                cycle.join(" -> ")
            ),
        );
    }

    diagnostics
}

fn links_to_type(concept: &ConceptRuleInput, context: &RuleContext<'_>, target_type: &str) -> bool {
    context
        .links
        .iter()
        .filter(|link| link.source_concept_id == concept.id)
        .filter(|link| link.kind == LinkKind::Internal && link.resolved)
        .filter_map(|link| link.target_concept_id.as_deref())
        .filter_map(|target_id| context.concepts_by_id.get(target_id))
        .any(|target| target.concept_type.eq_ignore_ascii_case(target_type))
}

fn push_concept_diagnostic(
    diagnostics: &mut Vec<Diagnostic>,
    options: &RuleOptions,
    code: &str,
    default_severity: Severity,
    concept: &ConceptRuleInput,
    message: &str,
) {
    if let Some(severity) = resolve_rule_severity(options, code, default_severity) {
        diagnostics.push(Diagnostic {
            code: code.to_string(),
            severity,
            message: message.to_string(),
            path: Some(concept.path.clone()),
            concept_id: Some(concept.id.clone()),
        });
    }
}

fn push_link_diagnostic(
    diagnostics: &mut Vec<Diagnostic>,
    options: &RuleOptions,
    code: &str,
    default_severity: Severity,
    link: &LinkRuleInput,
    message: &str,
) {
    if let Some(severity) = resolve_rule_severity(options, code, default_severity) {
        diagnostics.push(Diagnostic {
            code: code.to_string(),
            severity,
            message: message.to_string(),
            path: Some(link.source_path.clone()),
            concept_id: Some(link.source_concept_id.clone()),
        });
    }
}

fn resolve_rule_severity(
    options: &RuleOptions,
    code: &str,
    default_severity: Severity,
) -> Option<Severity> {
    match options.rule_levels.get(code).copied() {
        Some(RuleLevel::Off) => None,
        Some(RuleLevel::Error) => Some(Severity::Error),
        Some(RuleLevel::Warning) => Some(Severity::Warning),
        Some(RuleLevel::Advice) => Some(Severity::Advice),
        Some(RuleLevel::Info) => Some(Severity::Info),
        None => Some(default_severity),
    }
}

fn configured_frontmatter_key_order(options: &RuleOptions) -> Vec<String> {
    if options.frontmatter_key_order.is_empty() {
        default_frontmatter_key_order()
    } else {
        options.frontmatter_key_order.clone()
    }
}

fn frontmatter_key_order_is_stable(raw: Option<&str>, configured_order: &[String]) -> bool {
    let Some(raw) = raw else {
        return true;
    };
    let keys = logical_lines(raw)
        .filter_map(frontmatter_key)
        .collect::<Vec<_>>();
    let mut desired = keys.clone();
    desired.sort_by(|left, right| {
        frontmatter_key_rank(left, configured_order)
            .cmp(&frontmatter_key_rank(right, configured_order))
            .then_with(|| left.cmp(right))
    });
    keys == desired
}

fn frontmatter_key(line: &str) -> Option<String> {
    if line.starts_with([' ', '\t']) {
        return None;
    }
    let (key, _) = line.split_once(':')?;
    let mut chars = key.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    if chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
        Some(key.to_string())
    } else {
        None
    }
}

fn frontmatter_key_rank(key: &str, configured_order: &[String]) -> usize {
    configured_order
        .iter()
        .position(|entry| entry == key)
        .unwrap_or(configured_order.len())
}

fn concept_headings(concept: &ConceptRuleInput) -> Vec<String> {
    if !concept.headings.is_empty() {
        return concept
            .headings
            .iter()
            .map(|heading| heading.trim().to_lowercase())
            .collect();
    }

    logical_lines(&concept.body_text)
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let heading = trimmed.strip_prefix('#')?;
            let heading = heading.trim_start_matches('#').trim();
            (!heading.is_empty()).then(|| heading.to_lowercase())
        })
        .collect()
}

fn has_heading(headings: &[String], expected: &str) -> bool {
    headings
        .iter()
        .any(|heading| heading == expected || heading.ends_with(&format!(" {expected}")))
}

fn is_auth_heading(heading: &str) -> bool {
    heading
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|word| {
            matches!(
                word,
                "auth"
                    | "authentication"
                    | "authorization"
                    | "authn"
                    | "authz"
                    | "oauth"
                    | "oauth2"
            )
        })
}

fn is_valid_concept_path(path: &str) -> bool {
    let Some(filename) = path.rsplit('/').next() else {
        return false;
    };
    let Some(stem) = filename.strip_suffix(".md") else {
        return false;
    };

    !matches!(stem, "" | "." | "..")
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && !path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
}

fn is_reserved_markdown_file(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|name| name == "index.md" || name == "log.md")
}

fn is_file_name_format(path: &str) -> bool {
    let Some(first) = path.chars().next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && path.ends_with(".md")
        && path.chars().all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '.' | '/' | '-')
        })
}

fn is_iso_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    let valid_len = bytes.len() == 20 || bytes.len() == 24;
    if !valid_len || *bytes.last().unwrap_or(&0) != b'Z' {
        return false;
    }
    let fixed = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if fixed
        .iter()
        .any(|(index, expected)| bytes.get(*index) != Some(expected))
    {
        return false;
    }
    if bytes.len() == 24 && bytes.get(19) != Some(&b'.') {
        return false;
    }
    let digit_positions = if bytes.len() == 20 {
        vec![0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
    } else {
        vec![0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22]
    };
    if digit_positions
        .iter()
        .any(|index| !bytes[*index].is_ascii_digit())
    {
        return false;
    }

    let month = number(value, 5, 7);
    let day = number(value, 8, 10);
    let year = number(value, 0, 4);
    let hour = number(value, 11, 13);
    let minute = number(value, 14, 16);
    let second = number(value, 17, 19);
    (1..=12).contains(&month)
        && day >= 1
        && day <= days_in_month(year, month)
        && hour <= 23
        && minute <= 59
        && second <= 59
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn number(value: &str, start: usize, end: usize) -> u32 {
    value[start..end].parse().unwrap_or_default()
}

fn is_kebab_case_tag(tag: &str) -> bool {
    let mut previous_dash = false;
    let mut seen = false;
    for ch in tag.chars() {
        match ch {
            'a'..='z' | '0'..='9' => {
                previous_dash = false;
                seen = true;
            }
            '-' if seen && !previous_dash => previous_dash = true,
            _ => return false,
        }
    }
    seen && !previous_dash
}

fn contains_suspicious_secret(value: &str) -> bool {
    contains_private_key(value) || contains_token_looking_value(value)
}

fn contains_private_key(value: &str) -> bool {
    value.contains("-----BEGIN ") && value.contains("PRIVATE KEY-----")
}

fn contains_aws_access_key(value: &str) -> bool {
    value
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|token| {
            token.len() == 20
                && token.starts_with("AKIA")
                && token[4..]
                    .chars()
                    .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit())
        })
}

fn contains_token_looking_value(value: &str) -> bool {
    contains_aws_access_key(value) || contains_assigned_secret(value)
}

fn contains_assigned_secret(value: &str) -> bool {
    logical_lines(value).any(|line| {
        let lower = line.to_lowercase();
        ["api_key", "api-key", "secret", "token"]
            .iter()
            .any(|key| lower.contains(key))
            && line
                .split(['=', ':'])
                .nth(1)
                .is_some_and(|candidate| secret_value_len(candidate) >= 20)
    })
}

fn secret_value_len(value: &str) -> usize {
    value
        .trim()
        .trim_matches(['"', '\''])
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        .count()
}

fn contains_unredacted_email(value: &str) -> bool {
    value.split_whitespace().any(|token| {
        let token = token.trim_matches(|ch: char| matches!(ch, ',' | '.' | ';' | ':' | ')' | '('));
        let Some((local, domain)) = token.split_once('@') else {
            return false;
        };
        !local.is_empty()
            && domain.contains('.')
            && local.chars().all(is_email_local_char)
            && domain
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    })
}

fn contains_internal_url(value: &str) -> bool {
    value.char_indices().any(|(start, _)| {
        let rest = &value[start..];
        let is_url = rest
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
            || rest
                .get(..8)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"));
        if !is_url
            || value[..start]
                .chars()
                .next_back()
                .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return false;
        }

        let end = rest
            .char_indices()
            .find_map(|(offset, character)| {
                (character.is_whitespace() || matches!(character, '<' | '>' | '"' | '\''))
                    .then_some(start + offset)
            })
            .unwrap_or(value.len());
        is_private_url(trim_url_candidate(&value[start..end]))
    })
}

fn trim_url_candidate(mut value: &str) -> &str {
    loop {
        let without_sentence_punctuation = value.trim_end_matches(|character: char| {
            matches!(character, '.' | ',' | ';' | ':' | '!' | '?')
        });
        if without_sentence_punctuation.len() != value.len() {
            value = without_sentence_punctuation;
            continue;
        }
        if value.ends_with(')') && value.matches(')').count() > value.matches('(').count() {
            value = &value[..value.len() - 1];
            continue;
        }
        if value.ends_with(']') && value.matches(']').count() > value.matches('[').count() {
            value = &value[..value.len() - 1];
            continue;
        }
        return value;
    }
}

fn concept_text_without_resources(concept: &ConceptRuleInput) -> String {
    let mut frontmatter_lines = Vec::new();
    let mut inside_resource = false;

    for line in logical_lines(concept.frontmatter_raw.as_deref().unwrap_or_default()) {
        if let Some(key) = top_level_frontmatter_key(line) {
            inside_resource = key.eq_ignore_ascii_case("resource");
        }
        if !inside_resource {
            frontmatter_lines.push(line);
        }
    }

    format!("{}\n{}", frontmatter_lines.join("\n"), concept.body_text)
}

fn top_level_frontmatter_key(line: &str) -> Option<&str> {
    if line.starts_with([' ', '\t']) {
        return None;
    }
    let (key, _) = line.split_once(':')?;
    let key = key.trim();
    let mut chars = key.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    chars
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        .then_some(key)
}

fn logical_lines(value: &str) -> impl Iterator<Item = &str> {
    value.split(['\r', '\n'])
}

fn is_email_local_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '%' | '+' | '-')
}

fn is_private_url(value: &str) -> bool {
    let Some(host) = resource_host(value) else {
        return false;
    };
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    if let Some(address) = parse_ipv4_host(&host) {
        return is_private_ipv4(address);
    }

    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => is_private_ipv4(address),
        Ok(IpAddr::V6(address)) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_private_ipv4(mapped);
            }
            let first = address.segments()[0];
            address.is_unspecified()
                || address.is_loopback()
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80
        }
        Err(_) => false,
    }
}

fn parse_ipv4_host(host: &str) -> Option<Ipv4Addr> {
    let parts = host.split('.').collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 4 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let numbers = parts
        .iter()
        .map(|part| parse_ipv4_number(part))
        .collect::<Option<Vec<_>>>()?;
    if numbers[..numbers.len() - 1]
        .iter()
        .any(|number| *number > 255)
    {
        return None;
    }

    let final_bits = 8 * (5 - numbers.len());
    let final_limit = 1_u64 << final_bits;
    let final_number = *numbers.last()?;
    if final_number >= final_limit {
        return None;
    }

    let mut address = final_number;
    for (index, number) in numbers[..numbers.len() - 1].iter().enumerate() {
        address += number << (8 * (3 - index));
    }
    Some(Ipv4Addr::from(address as u32))
}

fn parse_ipv4_number(value: &str) -> Option<u64> {
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        return (!hex.is_empty())
            .then(|| u64::from_str_radix(hex, 16).ok())
            .flatten();
    }
    let radix = if value.len() > 1 && value.starts_with('0') {
        8
    } else {
        10
    };
    u64::from_str_radix(value, radix).ok()
}

fn is_private_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_unspecified()
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
}

fn resource_host(value: &str) -> Option<String> {
    let (scheme, rest) = value.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    let host = authority
        .strip_prefix('[')
        .and_then(|host| host.split_once(']').map(|(host, _)| host))
        .unwrap_or_else(|| authority.split(':').next().unwrap_or_default())
        .trim()
        .trim_end_matches('.')
        .to_lowercase();
    (!host.is_empty()).then_some(host)
}

fn normalize_configured_host(value: &str) -> String {
    let without_trailing_dot = value.trim().trim_end_matches('.');
    without_trailing_dot
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(without_trailing_dot)
        .to_lowercase()
}

fn default_frontmatter_key_order() -> Vec<String> {
    [
        "type",
        "title",
        "description",
        "resource",
        "tags",
        "timestamp",
    ]
    .iter()
    .map(|key| key.to_string())
    .collect()
}

fn default_high_degree_threshold() -> usize {
    25
}

fn severity_rank(severity: Severity) -> u8 {
    match severity {
        Severity::Error => 4,
        Severity::Warning => 3,
        Severity::Advice => 2,
        Severity::Info => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_rules");
    }

    #[test]
    fn rejects_concept_paths_without_usable_ids() {
        for path in [".md", "concepts/.md", "..md", "...md"] {
            assert!(
                !is_valid_concept_path(path),
                "unexpected valid path: {path}"
            );
        }
    }

    #[test]
    fn runs_builtin_rules() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![
                concept("a")
                    .with_type("Metric")
                    .with_body("api_key = abcdefghijklmnopqrstuvwxyz\nContact admin@corp.com\nSee http://10.0.0.5/runbook\n-----BEGIN PRIVATE KEY-----")
                    .with_resource("https://example.com/shared")
                    .with_frontmatter("title: A\ntype: Metric")
                    .with_timestamp("2024-01-01")
                    .with_tag("Bad Tag"),
                concept("b")
                    .with_type("Table")
                    .with_title("A")
                    .with_resource("https://example.com/shared"),
                concept("c").with_title("A").with_path("index.md"),
                concept("API")
                    .with_type("API")
                    .with_path("Concepts/API.md")
                    .with_heading("Summary"),
                concept("d").with_type(""),
            ],
            links: vec![
                broken_link("a", "missing.md"),
                link("b", "c"),
                link("c", "b"),
            ],
            options: RuleOptions {
                resource_allow_hosts: vec!["docs.example.com".to_string()],
                high_degree_threshold: 2,
                ..RuleOptions::default()
            },
        });
        let codes = diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();

        assert!(codes.contains(&"spec/missing-type"));
        assert!(codes.contains(&"spec/reserved-filename-conflict"));
        assert!(codes.contains(&"hygiene/missing-description"));
        assert!(codes.contains(&"hygiene/duplicate-title"));
        assert!(codes.contains(&"hygiene/duplicate-resource"));
        assert!(codes.contains(&"graph/broken-internal-link"));
        assert!(codes.contains(&"graph/circular-reference"));
        assert!(codes.contains(&"graph/high-degree-hub"));
        assert!(codes.contains(&"style/frontmatter-key-order"));
        assert!(codes.contains(&"style/timestamp-format"));
        assert!(codes.contains(&"style/tag-format"));
        assert!(codes.contains(&"style/file-name-format"));
        assert!(codes.contains(&"agent/missing-owner"));
        assert!(codes.contains(&"agent/missing-usage"));
        assert!(codes.contains(&"agent/api-missing-auth-notes"));
        assert!(codes.contains(&"agent/metric-missing-source"));
        assert!(codes.contains(&"security/suspicious-secret"));
        assert!(codes.contains(&"security/private-key"));
        assert!(codes.contains(&"security/token-looking-value"));
        assert!(codes.contains(&"security/unredacted-email"));
        assert!(codes.contains(&"security/internal-url"));
        assert!(codes.contains(&"security/non-allowlisted-resource"));
        assert_eq!(diagnostics[0].severity, Severity::Error);
    }

    #[test]
    fn reports_missing_frontmatter_without_duplicate_missing_type() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![concept("a").without_frontmatter().with_type("")],
            links: Vec::new(),
            ..RuleInput::default()
        });
        let codes = diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();

        assert!(codes.contains(&"spec/missing-frontmatter"));
        assert!(!codes.contains(&"spec/missing-type"));
    }

    #[test]
    fn respects_rule_level_overrides() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![concept("a").with_body("")],
            links: Vec::new(),
            options: RuleOptions {
                rule_levels: BTreeMap::from([
                    ("hygiene/empty-body".to_string(), RuleLevel::Error),
                    ("hygiene/missing-title".to_string(), RuleLevel::Off),
                ]),
                ..RuleOptions::default()
            },
        });
        let codes = diagnostics
            .iter()
            .map(|diagnostic| (diagnostic.code.as_str(), diagnostic.severity))
            .collect::<Vec<_>>();

        assert!(codes.contains(&("hygiene/empty-body", Severity::Error)));
        assert!(
            !codes
                .iter()
                .any(|(code, _)| *code == "hygiene/missing-title")
        );
    }

    #[test]
    fn requires_meaningful_readiness_metadata_and_recognized_auth_headings() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![
                ConceptRuleInput {
                    description: Some("   ".to_string()),
                    owner: Some("   ".to_string()),
                    headings: vec!["Author".to_string(), "API Usage".to_string()],
                    ..concept("author").with_type("API")
                },
                ConceptRuleInput {
                    description: Some("OAuth-protected endpoint.".to_string()),
                    owner: Some("api-team".to_string()),
                    headings: vec!["Usage".to_string(), "OAuth 2.0".to_string()],
                    ..concept("oauth").with_type("API")
                },
            ],
            ..RuleInput::default()
        });
        let paths_for = |code: &str| {
            diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == code)
                .filter_map(|diagnostic| diagnostic.path.as_deref())
                .collect::<Vec<_>>()
        };

        assert_eq!(paths_for("agent/missing-owner"), vec!["author.md"]);
        assert_eq!(paths_for("agent/missing-summary"), vec!["author.md"]);
        assert_eq!(paths_for("agent/api-missing-auth-notes"), vec!["author.md"]);
        assert!(paths_for("agent/missing-usage").is_empty());
    }

    #[test]
    fn normalizes_configured_resource_hosts() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![concept("docs").with_resource("https://DOCS.Example.com./guide")],
            options: RuleOptions {
                resource_allow_hosts: vec!["  Docs.Example.COM.  ".to_string()],
                ..RuleOptions::default()
            },
            ..RuleInput::default()
        });

        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "security/non-allowlisted-resource")
        );
    }

    #[test]
    fn validates_calendar_dates_in_iso_timestamps() {
        assert!(is_iso_timestamp("2024-02-29T23:59:59.000Z"));
        assert!(!is_iso_timestamp("2025-02-29T00:00:00Z"));
        assert!(!is_iso_timestamp("2024-04-31T00:00:00Z"));
    }

    #[test]
    fn counts_unique_neighbors_for_graph_degree() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![concept("source"), concept("target")],
            links: (0..25).map(|_| link("source", "target")).collect(),
            options: RuleOptions {
                high_degree_threshold: 2,
                ..RuleOptions::default()
            },
        });

        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "graph/high-degree-hub")
        );
    }

    #[test]
    fn reports_each_concept_once_for_normalized_duplicate_resources() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![
                concept("a")
                    .with_resource(" https://example.com/shared ")
                    .with_resource("https://example.com/shared"),
                concept("b").with_resource("https://EXAMPLE.com/shared"),
            ],
            ..RuleInput::default()
        });

        let paths = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "hygiene/duplicate-resource")
            .filter_map(|diagnostic| diagnostic.path.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["a.md", "b.md"]);
    }

    #[test]
    fn excludes_resource_fields_from_internal_url_checks() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![concept("resource")
                .with_frontmatter(
                    "type: Note\nresource:\n  - http://localhost/runbook\ndescription: Public docs",
                )
                .with_resource("http://localhost/runbook")],
            ..RuleInput::default()
        });
        let codes = diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();

        assert!(codes.contains(&"security/private-url"));
        assert!(!codes.contains(&"security/internal-url"));
    }

    #[test]
    fn scans_rules_across_carriage_return_line_endings() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![
                concept("carriage-return")
                    .with_frontmatter(
                        "title: Example\rtype: Note\rresource:\r  - http://localhost/runbook",
                    )
                    .with_body("title: Example\rapi_key = abcdefghijklmnopqrstuvwxyz")
                    .with_resource("http://localhost/runbook"),
            ],
            ..RuleInput::default()
        });
        let codes = diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();

        assert!(codes.contains(&"style/frontmatter-key-order"));
        assert!(codes.contains(&"security/token-looking-value"));
        assert!(!codes.contains(&"security/internal-url"));
    }

    #[test]
    fn ignores_nested_keys_when_checking_frontmatter_order() {
        let diagnostics =
            run_builtin_rules(RuleInput {
                concepts: vec![concept("nested").with_frontmatter(
                    "type: Note\ntitle: Nested\nmetadata:\n  zebra: 1\n  alpha: 2",
                )],
                ..RuleInput::default()
            });

        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "style/frontmatter-key-order")
        );
    }

    #[test]
    fn attributes_circular_references_to_concepts_in_the_cycle() {
        let diagnostics = run_builtin_rules(RuleInput {
            concepts: vec![concept("a"), concept("b"), concept("c")],
            links: vec![link("a", "b"), link("b", "c"), link("c", "b")],
            ..RuleInput::default()
        });

        let paths = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "graph/circular-reference")
            .filter_map(|diagnostic| diagnostic.path.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["b.md"]);
    }

    #[test]
    fn checks_dense_acyclic_graphs_without_enumerating_paths() {
        let node_count = 32;
        let concepts = (0..node_count)
            .map(|index| concept(&format!("node-{index}")))
            .collect();
        let links = (0..node_count)
            .flat_map(|source| {
                (source + 1..node_count)
                    .map(move |target| link(&format!("node-{source}"), &format!("node-{target}")))
            })
            .collect();
        let diagnostics = run_builtin_rules(RuleInput {
            concepts,
            links,
            ..RuleInput::default()
        });

        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "graph/circular-reference")
        );
    }

    #[test]
    fn classifies_private_ip_ranges_without_numeric_domain_false_positives() {
        for url in [
            "http://127.0.0.2/loopback",
            "http://169.254.1.2/link-local",
            "http://100.64.0.1/shared",
            "http://[::1]/loopback",
            "http://[fc00::1]/private",
            "http://[fe80::1]/link-local",
            "http://[::ffff:127.0.0.1]/mapped",
            "http://2130706433/integer-loopback",
            "http://0x7f000001/hex-loopback",
            "http://127.1/short-loopback",
            "http://192.168.1/short-private",
            "http://0177.0.0.1/octal-loopback",
            "HTTP://127.0.0.2/uppercase-scheme",
        ] {
            assert!(is_private_url(url), "expected private URL: {url}");
        }
        for url in [
            "http://10.example.com/public",
            "http://100.128.0.1/public",
            "http://[2001:db8::1]/documentation",
            "http://[::ffff:8.8.8.8]/mapped-public",
        ] {
            assert!(!is_private_url(url), "unexpected private URL: {url}");
        }
    }

    #[test]
    fn extracts_private_urls_from_markdown_links() {
        assert!(contains_internal_url(
            "See [Local](HTTP://[::1]/admin) for details."
        ));
        assert!(contains_internal_url(
            "See [Mapped](http://[::ffff:127.0.0.1]/admin)."
        ));
        assert!(!contains_internal_url(
            "See [Public](https://[2001:db8::1]/guide)."
        ));
    }

    fn concept(id: &str) -> ConceptRuleInput {
        ConceptRuleInput {
            id: id.to_string(),
            path: format!("{id}.md"),
            concept_type: "Note".to_string(),
            body_text: "# Body".to_string(),
            has_frontmatter: Some(true),
            ..ConceptRuleInput::default()
        }
    }

    fn broken_link(source: &str, target: &str) -> LinkRuleInput {
        LinkRuleInput {
            source_concept_id: source.to_string(),
            source_path: format!("{source}.md"),
            target_raw: target.to_string(),
            kind: LinkKind::Internal,
            resolved: false,
            ..LinkRuleInput::default()
        }
    }

    fn link(source: &str, target: &str) -> LinkRuleInput {
        LinkRuleInput {
            source_concept_id: source.to_string(),
            source_path: format!("{source}.md"),
            target_raw: format!("{target}.md"),
            target_concept_id: Some(target.to_string()),
            kind: LinkKind::Internal,
            resolved: true,
        }
    }

    trait ConceptBuilder {
        fn with_type(self, concept_type: &str) -> Self;
        fn with_title(self, title: &str) -> Self;
        fn with_body(self, body: &str) -> Self;
        fn with_resource(self, resource: &str) -> Self;
        fn with_path(self, path: &str) -> Self;
        fn with_frontmatter(self, raw: &str) -> Self;
        fn with_timestamp(self, timestamp: &str) -> Self;
        fn with_tag(self, tag: &str) -> Self;
        fn with_heading(self, heading: &str) -> Self;
        fn without_frontmatter(self) -> Self;
    }

    impl ConceptBuilder for ConceptRuleInput {
        fn with_type(mut self, concept_type: &str) -> Self {
            self.concept_type = concept_type.to_string();
            self
        }

        fn with_title(mut self, title: &str) -> Self {
            self.title = Some(title.to_string());
            self
        }

        fn with_body(mut self, body: &str) -> Self {
            self.body_text = body.to_string();
            self
        }

        fn with_resource(mut self, resource: &str) -> Self {
            self.resource.push(resource.to_string());
            self
        }

        fn with_path(mut self, path: &str) -> Self {
            self.path = path.to_string();
            self
        }

        fn with_frontmatter(mut self, raw: &str) -> Self {
            self.frontmatter_raw = Some(raw.to_string());
            self
        }

        fn with_timestamp(mut self, timestamp: &str) -> Self {
            self.timestamp = Some(timestamp.to_string());
            self
        }

        fn with_tag(mut self, tag: &str) -> Self {
            self.tags.push(tag.to_string());
            self
        }

        fn with_heading(mut self, heading: &str) -> Self {
            self.headings.push(heading.to_string());
            self
        }

        fn without_frontmatter(mut self) -> Self {
            self.has_frontmatter = Some(false);
            self.frontmatter_raw = None;
            self
        }
    }
}
