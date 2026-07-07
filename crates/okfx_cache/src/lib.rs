use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub const CRATE_NAME: &str = "okfx_cache";
pub const CACHE_SCHEMA_VERSION: u8 = 1;
pub const DEFAULT_CACHE_DIR: &str = ".okfx/cache";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheKey {
    pub okfx_version: String,
    pub config_hash: String,
    pub path: String,
    pub content_hash: String,
    pub parser_version: String,
    pub rule_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedParseOutput {
    pub frontmatter: BTreeMap<String, serde_json::Value>,
    pub links: Vec<CachedLink>,
    pub headings: Vec<CachedHeading>,
    pub diagnostics: Vec<CachedDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedLink {
    pub source_concept_id: String,
    pub target_raw: String,
    pub target_concept_id: Option<String>,
    pub kind: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedHeading {
    pub level: usize,
    pub title: String,
    pub slug: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedDiagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub path: Option<String>,
    pub concept_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CacheEntry {
    pub schema_version: u8,
    pub key: CacheKey,
    pub output: CachedParseOutput,
    pub stored_at: Option<String>,
}

impl CacheEntry {
    pub fn new(key: CacheKey, output: CachedParseOutput) -> Self {
        Self {
            schema_version: CACHE_SCHEMA_VERSION,
            key,
            output,
            stored_at: None,
        }
    }

    pub fn with_stored_at(mut self, stored_at: impl Into<String>) -> Self {
        self.stored_at = Some(stored_at.into());
        self
    }

    pub fn is_fresh_for(&self, key: &CacheKey) -> bool {
        self.schema_version == CACHE_SCHEMA_VERSION && &self.key == key
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CacheLookup {
    Hit(CacheEntry),
    Miss(CacheMiss),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CacheMiss {
    Missing,
    Invalid { message: String },
    SchemaMismatch { found: u8, expected: u8 },
    KeyMismatch { found: CacheKey },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheError {
    Io { path: PathBuf, message: String },
    Encode { message: String },
    Decode { path: PathBuf, message: String },
}

impl fmt::Display for CacheError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CacheError::Io { path, message } => {
                write!(
                    formatter,
                    "cache I/O error at {}: {message}",
                    path.display()
                )
            }
            CacheError::Encode { message } => write!(formatter, "cache encode error: {message}"),
            CacheError::Decode { path, message } => {
                write!(
                    formatter,
                    "cache decode error at {}: {message}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for CacheError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheStore {
    cache_dir: PathBuf,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

impl CacheStore {
    pub fn new(bundle_root: impl AsRef<Path>) -> Self {
        Self {
            cache_dir: bundle_root.as_ref().join(DEFAULT_CACHE_DIR),
        }
    }

    pub fn at(cache_dir: impl AsRef<Path>) -> Self {
        Self {
            cache_dir: cache_dir.as_ref().to_path_buf(),
        }
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    pub fn cache_path(&self, key: &CacheKey) -> Result<PathBuf, CacheError> {
        let id = cache_key_hash(key)?;
        Ok(self.cache_dir.join(&id[..2]).join(format!("{id}.json")))
    }

    pub fn lookup(&self, key: &CacheKey) -> Result<CacheLookup, CacheError> {
        let path = self.cache_path(key)?;
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(CacheLookup::Miss(CacheMiss::Missing));
            }
            Err(error) => {
                return Err(CacheError::Io {
                    path,
                    message: error.to_string(),
                });
            }
        };

        let entry = match serde_json::from_str::<CacheEntry>(&content) {
            Ok(entry) => entry,
            Err(error) => {
                return Ok(CacheLookup::Miss(CacheMiss::Invalid {
                    message: error.to_string(),
                }));
            }
        };

        if entry.schema_version != CACHE_SCHEMA_VERSION {
            return Ok(CacheLookup::Miss(CacheMiss::SchemaMismatch {
                found: entry.schema_version,
                expected: CACHE_SCHEMA_VERSION,
            }));
        }
        if entry.key != *key {
            return Ok(CacheLookup::Miss(CacheMiss::KeyMismatch {
                found: entry.key,
            }));
        }

        Ok(CacheLookup::Hit(entry))
    }

    pub fn read_entry(&self, key: &CacheKey) -> Result<Option<CacheEntry>, CacheError> {
        match self.lookup(key)? {
            CacheLookup::Hit(entry) => Ok(Some(entry)),
            CacheLookup::Miss(_) => Ok(None),
        }
    }

    pub fn write_entry(&self, entry: &CacheEntry) -> Result<PathBuf, CacheError> {
        let path = self.cache_path(&entry.key)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| CacheError::Io {
                path: parent.to_path_buf(),
                message: error.to_string(),
            })?;
        }
        let content = serde_json::to_vec_pretty(entry).map_err(|error| CacheError::Encode {
            message: error.to_string(),
        })?;
        fs::write(&path, content).map_err(|error| CacheError::Io {
            path: path.clone(),
            message: error.to_string(),
        })?;
        Ok(path)
    }

    pub fn remove_entry(&self, key: &CacheKey) -> Result<bool, CacheError> {
        let path = self.cache_path(key)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(CacheError::Io {
                path,
                message: error.to_string(),
            }),
        }
    }
}

pub fn make_cache_key(
    okfx_version: impl Into<String>,
    config_hash: impl Into<String>,
    path: impl Into<String>,
    content_hash: impl Into<String>,
    parser_version: impl Into<String>,
    rule_version: impl Into<String>,
) -> CacheKey {
    CacheKey {
        okfx_version: okfx_version.into(),
        config_hash: config_hash.into(),
        path: normalize_path(&path.into()),
        content_hash: content_hash.into(),
        parser_version: parser_version.into(),
        rule_version: rule_version.into(),
    }
}

pub fn content_hash(content: impl AsRef<[u8]>) -> String {
    sha256_hex(content.as_ref())
}

pub fn config_hash(config: &serde_json::Value) -> Result<String, CacheError> {
    let bytes = serde_json::to_vec(config).map_err(|error| CacheError::Encode {
        message: error.to_string(),
    })?;
    Ok(sha256_hex(&bytes))
}

pub fn cache_key_hash(key: &CacheKey) -> Result<String, CacheError> {
    let bytes = serde_json::to_vec(key).map_err(|error| CacheError::Encode {
        message: error.to_string(),
    })?;
    Ok(sha256_hex(&bytes))
}

fn sha256_hex(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hex_digest(hasher.finalize().as_slice())
}

fn hex_digest(input: &[u8]) -> String {
    input.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_cache");
    }

    #[test]
    fn builds_stable_hashes_and_keys() {
        let key = make_cache_key(
            "0.1.0",
            config_hash(&json!({"rules":{"a":"warning"}})).unwrap(),
            "./concepts\\wau.md",
            content_hash(b"body"),
            "parser-v1",
            "rules-v1",
        );

        assert_eq!(key.path, "concepts/wau.md");
        assert_eq!(key.content_hash.len(), 64);
        assert_eq!(cache_key_hash(&key).unwrap().len(), 64);
    }

    #[test]
    fn writes_reads_and_removes_cache_entries() {
        let root = temp_root("store");
        let store = CacheStore::new(&root);
        let key = sample_key("sha256:one");
        let entry =
            CacheEntry::new(key.clone(), sample_output()).with_stored_at("2026-07-07T00:00:00Z");

        let path = store.write_entry(&entry).unwrap();
        assert!(path.starts_with(root.join(DEFAULT_CACHE_DIR)));
        assert_eq!(store.read_entry(&key).unwrap(), Some(entry.clone()));
        assert_eq!(store.lookup(&key).unwrap(), CacheLookup::Hit(entry));

        assert!(store.remove_entry(&key).unwrap());
        assert_eq!(
            store.lookup(&key).unwrap(),
            CacheLookup::Miss(CacheMiss::Missing)
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_cache_miss_reasons() {
        let root = temp_root("miss");
        let store = CacheStore::new(&root);
        let key = sample_key("sha256:one");
        let other_key = sample_key("sha256:two");
        let mut entry = CacheEntry::new(key.clone(), sample_output());
        entry.schema_version = 99;

        store.write_entry(&entry).unwrap();
        assert_eq!(
            store.lookup(&key).unwrap(),
            CacheLookup::Miss(CacheMiss::SchemaMismatch {
                found: 99,
                expected: CACHE_SCHEMA_VERSION
            })
        );

        let other_path = store.cache_path(&other_key).unwrap();
        fs::create_dir_all(other_path.parent().unwrap()).unwrap();
        fs::write(
            &other_path,
            serde_json::to_vec(&CacheEntry::new(key, sample_output())).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            store.lookup(&other_key).unwrap(),
            CacheLookup::Miss(CacheMiss::KeyMismatch { .. })
        ));

        fs::write(&other_path, b"not json").unwrap();
        assert!(matches!(
            store.lookup(&other_key).unwrap(),
            CacheLookup::Miss(CacheMiss::Invalid { .. })
        ));

        fs::remove_dir_all(root).unwrap();
    }

    fn sample_key(content_hash: &str) -> CacheKey {
        make_cache_key(
            "0.1.0",
            "config-hash",
            "concepts/wau.md",
            content_hash,
            "parser-v1",
            "rules-v1",
        )
    }

    fn sample_output() -> CachedParseOutput {
        CachedParseOutput {
            frontmatter: BTreeMap::from([("type".to_string(), json!("Metric"))]),
            links: vec![CachedLink {
                source_concept_id: "concepts/wau".to_string(),
                target_raw: "../tables/events.md".to_string(),
                target_concept_id: Some("tables/events".to_string()),
                kind: "internal".to_string(),
                resolved: true,
            }],
            headings: vec![CachedHeading {
                level: 2,
                title: "Usage".to_string(),
                slug: "usage".to_string(),
            }],
            diagnostics: vec![CachedDiagnostic {
                code: "hygiene/missing-description".to_string(),
                severity: "warning".to_string(),
                message: "Concept should include a description.".to_string(),
                path: Some("concepts/wau.md".to_string()),
                concept_id: Some("concepts/wau".to_string()),
            }],
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("okfx-cache-{name}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }
}
