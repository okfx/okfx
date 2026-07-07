use okfx_parser::{DiagnosticSeverity, LinkKind, parse_markdown_document};

#[test]
fn tolerates_malformed_yaml_frontmatter() {
    let parsed = parse_markdown_document(
        "bad-yaml.md",
        "---\ntype: [\n---\n# Broken\n[link](../outside.md)\n",
        "bad-yaml",
    );

    assert_eq!(parsed.diagnostics.len(), 1);
    assert_eq!(parsed.diagnostics[0].severity, DiagnosticSeverity::Error);
    assert_eq!(parsed.body.headings[0].title, "Broken");
    assert_eq!(parsed.links[0].kind, LinkKind::Internal);
}

#[test]
fn treats_unclosed_frontmatter_as_body_text() {
    let parsed = parse_markdown_document(
        "unclosed.md",
        "---\ntype: Note\n# No closing delimiter\n",
        "unclosed",
    );

    assert!(parsed.diagnostics.is_empty());
    assert!(parsed.frontmatter.is_none());
    assert!(parsed.body.text.contains("No closing delimiter"));
}

#[test]
fn tolerates_unusual_markdown_and_unicode() {
    let parsed = parse_markdown_document(
        "unicode.md",
        "---\ntype: Note\n---\n# Café 指标\n\n[text](./路径.md?x=1#片段)\n![alt](image.png)\n[site](https://example.com/a?b=c)\n",
        "unicode",
    );

    assert!(parsed.diagnostics.is_empty());
    assert_eq!(parsed.body.headings[0].slug, "café-指标");
    assert!(
        parsed
            .links
            .iter()
            .any(|link| link.kind == LinkKind::Internal)
    );
    assert!(
        parsed
            .links
            .iter()
            .any(|link| link.kind == LinkKind::External)
    );
}

#[test]
fn tolerates_large_frontmatter_scalar() {
    let large = "a".repeat(32_000);
    let parsed = parse_markdown_document(
        "large.md",
        format!("---\ntype: Note\ndescription: {large}\n---\n# Large\n"),
        "large",
    );

    assert!(parsed.diagnostics.is_empty());
    assert_eq!(
        parsed
            .frontmatter
            .as_ref()
            .and_then(|frontmatter| frontmatter.get("type"))
            .unwrap()
            .as_str()
            .unwrap(),
        "Note"
    );
}
