use serde::{Deserialize, Serialize};
use serde_json::json;
use wasm_bindgen::prelude::*;

pub const CRATE_NAME: &str = "okfx_wasm";

#[derive(Debug, Deserialize)]
struct ResolveLinksRequest {
    entries: Vec<okfx_resolver::LinkEntry>,
    concept_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct BuildGraphRequest {
    concepts: Vec<okfx_graph::ConceptNodeInput>,
    links: Vec<okfx_resolver::ResolvedLink>,
}

#[derive(Debug, Deserialize)]
struct BuildSearchIndexRequest {
    okf_version: Option<String>,
    documents: Vec<okfx_index::IndexDocumentInput>,
}

#[derive(Debug, Deserialize)]
struct BuildPackMetadataRequest {
    files: Vec<WasmPackInputFile>,
    okfx_version: String,
    okf_version: String,
    bundle_name: String,
    created_at: String,
    source: okfx_pack::ManifestSource,
}

#[derive(Debug, Deserialize)]
struct WasmPackInputFile {
    path: String,
    content: String,
    concept_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct WasmFormatResult {
    formatted: String,
    changed: bool,
    diagnostics: Vec<WasmFormatDiagnostic>,
}

#[derive(Debug, Serialize)]
struct WasmFormatDiagnostic {
    code: String,
    message: String,
    path: Option<String>,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

#[wasm_bindgen]
pub fn wasm_capabilities_json() -> Result<String, JsValue> {
    to_json(&json!({
        "crate": CRATE_NAME,
        "interface": "json",
        "capabilities": [
            "parse",
            "resolve",
            "rules",
            "graph",
            "format",
            "index",
            "pack",
            "cache"
        ]
    }))
}

#[wasm_bindgen]
pub fn parse_markdown_document_json(
    path: String,
    content: String,
    source_concept_id: String,
) -> Result<String, JsValue> {
    to_json(&okfx_parser::parse_markdown_document(
        path,
        content,
        source_concept_id,
    ))
}

#[wasm_bindgen]
pub fn resolve_links_json(request_json: String) -> Result<String, JsValue> {
    let request = from_json::<ResolveLinksRequest>(&request_json)?;
    to_json(&okfx_resolver::resolve_links(
        request.entries,
        request.concept_ids,
    ))
}

#[wasm_bindgen]
pub fn run_builtin_rules_json(input_json: String) -> Result<String, JsValue> {
    let input = from_json::<okfx_rules::RuleInput>(&input_json)?;
    to_json(&okfx_rules::run_builtin_rules(input))
}

#[wasm_bindgen]
pub fn build_graph_json(request_json: String) -> Result<String, JsValue> {
    let request = from_json::<BuildGraphRequest>(&request_json)?;
    to_json(&okfx_graph::build_graph(request.concepts, request.links))
}

#[wasm_bindgen]
pub fn format_markdown_document_json(
    path: String,
    content: String,
    key_order_json: String,
) -> Result<String, JsValue> {
    let result = if key_order_json.trim().is_empty() {
        okfx_fmt::format_markdown_document(path, content)
    } else {
        let key_order = from_json::<Vec<String>>(&key_order_json)?;
        let key_order_refs = key_order.iter().map(String::as_str).collect::<Vec<_>>();
        okfx_fmt::format_markdown_document_with_key_order(path, content, &key_order_refs)
    };
    to_json(&WasmFormatResult::from(result))
}

#[wasm_bindgen]
pub fn build_search_index_json(request_json: String) -> Result<String, JsValue> {
    let request = from_json::<BuildSearchIndexRequest>(&request_json)?;
    to_json(&okfx_index::build_search_index(
        request.okf_version,
        request.documents,
    ))
}

#[wasm_bindgen]
pub fn build_pack_metadata_json(request_json: String) -> Result<String, JsValue> {
    let request = from_json::<BuildPackMetadataRequest>(&request_json)?;
    let files = request
        .files
        .into_iter()
        .map(|file| okfx_pack::PackInputFile {
            path: file.path,
            content: file.content.into_bytes(),
            concept_id: file.concept_id,
        })
        .collect::<Vec<_>>();
    to_json(&okfx_pack::build_pack_metadata(
        files,
        request.okfx_version,
        request.okf_version,
        request.bundle_name,
        request.created_at,
        request.source,
    ))
}

#[wasm_bindgen]
pub fn make_cache_key_json(
    okfx_version: String,
    config_hash: String,
    path: String,
    content_hash: String,
    parser_version: String,
    rule_version: String,
) -> Result<String, JsValue> {
    to_json(&okfx_cache::make_cache_key(
        okfx_version,
        config_hash,
        path,
        content_hash,
        parser_version,
        rule_version,
    ))
}

#[wasm_bindgen]
pub fn cache_content_hash(content: String) -> String {
    okfx_cache::content_hash(content)
}

#[wasm_bindgen]
pub fn cache_config_hash_json(config_json: String) -> Result<String, JsValue> {
    let config = from_json::<serde_json::Value>(&config_json)?;
    okfx_cache::config_hash(&config).map_err(js_error)
}

#[wasm_bindgen]
pub fn cache_key_hash_json(key_json: String) -> Result<String, JsValue> {
    let key = from_json::<okfx_cache::CacheKey>(&key_json)?;
    okfx_cache::cache_key_hash(&key).map_err(js_error)
}

impl From<okfx_fmt::FormatResult> for WasmFormatResult {
    fn from(value: okfx_fmt::FormatResult) -> Self {
        Self {
            formatted: value.formatted,
            changed: value.changed,
            diagnostics: value
                .diagnostics
                .into_iter()
                .map(|diagnostic| WasmFormatDiagnostic {
                    code: diagnostic.code,
                    message: diagnostic.message,
                    path: diagnostic.path,
                })
                .collect(),
        }
    }
}

fn to_json<T: Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(js_error)
}

fn from_json<T: for<'de> Deserialize<'de>>(value: &str) -> Result<T, JsValue> {
    serde_json::from_str(value).map_err(js_error)
}

fn js_error(error: impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_wasm");
    }

    #[test]
    fn exposes_capabilities() {
        let value = parse_value(&wasm_capabilities_json().unwrap());
        assert_eq!(value["crate"], "okfx_wasm");
        assert!(
            value["capabilities"]
                .as_array()
                .unwrap()
                .contains(&Value::String("cache".to_string()))
        );
    }

    #[test]
    fn parses_formats_and_hashes_json_boundaries() {
        let parsed = parse_value(
            &parse_markdown_document_json(
                "concept.md".to_string(),
                "---\ntype: Note\n---\n# Title\n".to_string(),
                "concept".to_string(),
            )
            .unwrap(),
        );
        assert_eq!(parsed["body"]["headings"][0]["slug"], "title");

        let formatted = parse_value(
            &format_markdown_document_json(
                "concept.md".to_string(),
                "---\ntitle: Example\ntype: Note\n---\n# Title".to_string(),
                "".to_string(),
            )
            .unwrap(),
        );
        assert_eq!(formatted["changed"], true);
        assert_eq!(cache_content_hash("body".to_string()).len(), 64);
    }

    #[test]
    fn runs_rules_graph_index_and_pack_json_boundaries() {
        let rules = parse_value(
            &run_builtin_rules_json(
                json!({
                    "concepts": [{
                        "id": "a",
                        "path": "a.md",
                        "concept_type": "",
                        "title": null,
                        "description": null,
                        "body_text": "",
                        "resource": [],
                        "tags": []
                    }],
                    "links": []
                })
                .to_string(),
            )
            .unwrap(),
        );
        assert!(
            rules
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| { diagnostic["code"] == "spec/missing-type" })
        );

        let graph = parse_value(
            &build_graph_json(
                json!({
                    "concepts": [{
                        "id": "a",
                        "path": "a.md",
                        "concept_type": "Note",
                        "title": "A",
                        "resource": ["https://docs.example.com/a"],
                        "tags": ["analytics"]
                    }],
                    "links": []
                })
                .to_string(),
            )
            .unwrap(),
        );
        assert_eq!(graph["stats"]["node_count"], 1);
        assert_eq!(graph["stats"]["edge_count"], 2);
        assert_eq!(graph["edges"][0]["kind"], "resource");
        assert_eq!(graph["edges"][1]["kind"], "tag");

        let index = parse_value(
            &build_search_index_json(
                json!({
                    "okf_version": "0.1",
                    "documents": [{
                        "id": "a",
                        "path": "a.md",
                        "concept_type": "Note",
                        "title": "A",
                        "description": null,
                        "tags": [],
                        "headings": [],
                        "body": "Alpha beta",
                        "backlinks": []
                    }]
                })
                .to_string(),
            )
            .unwrap(),
        );
        assert_eq!(index["terms"]["beta"][0], "a");
        assert_eq!(index["generated_from"]["okf_version"], "0.1");
        assert_eq!(index["generated_from"]["concept_count"], 1);
        assert_eq!(index["documents"][0]["type"], "Note");
        assert!(index["documents"][0].get("concept_type").is_none());

        let pack = parse_value(
            &build_pack_metadata_json(
                json!({
                    "files": [{
                        "path": "a.md",
                        "content": "body",
                        "concept_id": "a"
                    }],
                    "okfx_version": "0.1.0",
                    "okf_version": "0.1",
                    "bundle_name": "demo",
                    "created_at": "2026-07-07T00:00:00Z",
                    "source": {
                        "git_commit": null,
                        "git_remote": null,
                        "dirty": false
                    }
                })
                .to_string(),
            )
            .unwrap(),
        );
        assert_eq!(pack["manifest"]["content_hash"].as_str().unwrap().len(), 64);
    }

    fn parse_value(value: &str) -> Value {
        serde_json::from_str(value).unwrap()
    }
}
