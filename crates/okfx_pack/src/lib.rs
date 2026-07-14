use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use unicode_normalization::UnicodeNormalization;

pub const CRATE_NAME: &str = "okfx_pack";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackInputFile {
    pub path: String,
    pub content: Vec<u8>,
    pub concept_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub concept_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestSource {
    pub git_commit: Option<String>,
    pub git_remote: Option<String>,
    pub dirty: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub manifest_schema_version: u8,
    pub okfx_version: String,
    pub okf_version: String,
    pub bundle_name: String,
    pub created_at: String,
    pub concept_count: usize,
    pub file_count: usize,
    pub content_hash: String,
    pub source: ManifestSource,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checksums {
    pub algorithm: String,
    pub files: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    pub created_at: String,
    pub created_by: String,
    pub okfx_version: String,
    pub source: ManifestSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackMetadata {
    pub manifest: Manifest,
    pub checksums: Checksums,
    pub provenance: Provenance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackError {
    InvalidPath { path: String },
    DuplicatePath { path: String },
}

impl fmt::Display for PackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PackError::InvalidPath { path } => {
                write!(
                    formatter,
                    "pack input path is not a safe relative path: {path:?}"
                )
            }
            PackError::DuplicatePath { path } => {
                write!(
                    formatter,
                    "pack input path is duplicated after normalization: {path:?}"
                )
            }
        }
    }
}

impl std::error::Error for PackError {}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn build_pack_metadata(
    files: Vec<PackInputFile>,
    okfx_version: impl Into<String>,
    okf_version: impl Into<String>,
    bundle_name: impl Into<String>,
    created_at: impl Into<String>,
    source: ManifestSource,
) -> Result<PackMetadata, PackError> {
    let okfx_version = okfx_version.into();
    let created_at = created_at.into();
    let mut seen_paths = BTreeSet::new();
    let mut manifest_files = Vec::with_capacity(files.len());
    for file in files {
        let path = normalize_path(&file.path)?;
        if !seen_paths.insert(portable_path_key(&path)) {
            return Err(PackError::DuplicatePath { path });
        }
        manifest_files.push(ManifestFile {
            path,
            sha256: sha256_hex(&file.content),
            concept_id: file.concept_id,
        });
    }
    manifest_files.sort_by(|left, right| left.path.cmp(&right.path));

    let checksums = Checksums {
        algorithm: "sha256".to_string(),
        files: manifest_files
            .iter()
            .map(|file| (file.path.clone(), file.sha256.clone()))
            .collect(),
    };
    let content_hash = content_hash(&manifest_files);
    let manifest = Manifest {
        manifest_schema_version: 1,
        okfx_version: okfx_version.clone(),
        okf_version: okf_version.into(),
        bundle_name: bundle_name.into(),
        created_at: created_at.clone(),
        concept_count: manifest_files
            .iter()
            .filter(|file| file.concept_id.is_some())
            .count(),
        file_count: manifest_files.len(),
        content_hash,
        source: source.clone(),
        files: manifest_files,
    };
    let provenance = Provenance {
        created_at,
        created_by: "okfx".to_string(),
        okfx_version,
        source,
    };

    Ok(PackMetadata {
        manifest,
        checksums,
        provenance,
    })
}

fn content_hash(files: &[ManifestFile]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"okfx-manifest-v1\n");
    for file in files {
        hasher.update(file.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(file.sha256.as_bytes());
        hasher.update(b"\0");
        if let Some(concept_id) = &file.concept_id {
            hasher.update(concept_id.as_bytes());
        }
        hasher.update(b"\n");
    }
    hex_digest(hasher.finalize().as_slice())
}

fn sha256_hex(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hex_digest(hasher.finalize().as_slice())
}

fn hex_digest(input: &[u8]) -> String {
    input.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn normalize_path(path: &str) -> Result<String, PackError> {
    let normalized = path.replace('\\', "/").trim_start_matches("./").to_string();
    let bytes = normalized.as_bytes();
    let has_windows_drive_prefix =
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains('\0')
        || has_windows_drive_prefix
        || normalized
            .split('/')
            .any(|segment| !is_portable_path_segment(segment))
    {
        return Err(PackError::InvalidPath {
            path: path.to_string(),
        });
    }
    Ok(normalized)
}

fn is_portable_path_segment(segment: &str) -> bool {
    if segment.is_empty()
        || matches!(segment, "." | "..")
        || segment.ends_with([' ', '.'])
        || segment
            .chars()
            .any(|character| character.is_control() || r#"<>:"|?*"#.contains(character))
    {
        return false;
    }

    let device_name = segment.split('.').next().unwrap_or_default().to_uppercase();
    !matches!(device_name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !matches_reserved_numbered_device(&device_name, "COM")
        && !matches_reserved_numbered_device(&device_name, "LPT")
}

fn matches_reserved_numbered_device(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
}

fn portable_path_key(path: &str) -> String {
    path.nfc().flat_map(char::to_lowercase).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_pack");
    }

    #[test]
    fn builds_deterministic_manifest_checksums_and_provenance() {
        let metadata = build_pack_metadata(
            vec![
                PackInputFile {
                    path: "b.md".to_string(),
                    content: b"b".to_vec(),
                    concept_id: Some("b".to_string()),
                },
                PackInputFile {
                    path: "./a.md".to_string(),
                    content: b"a".to_vec(),
                    concept_id: Some("a".to_string()),
                },
            ],
            "0.1.0",
            "0.1",
            "knowledge",
            "2026-07-07T00:00:00Z",
            ManifestSource {
                git_commit: Some("abc".to_string()),
                git_remote: None,
                dirty: Some(false),
            },
        )
        .unwrap();

        assert_eq!(metadata.manifest.file_count, 2);
        assert_eq!(metadata.manifest.concept_count, 2);
        assert_eq!(metadata.manifest.files[0].path, "a.md");
        assert_eq!(metadata.checksums.algorithm, "sha256");
        assert_eq!(metadata.checksums.files.len(), 2);
        assert_eq!(metadata.provenance.created_by, "okfx");
        assert_eq!(
            metadata.manifest.content_hash,
            "58657a1c026e23ab8fa445d46d482b1fa234d4571859961b08b0c1cf4c1ac5af"
        );
    }

    #[test]
    fn rejects_unsafe_and_duplicate_normalized_paths() {
        let metadata_for = |paths: &[&str]| {
            build_pack_metadata(
                paths
                    .iter()
                    .map(|path| PackInputFile {
                        path: (*path).to_string(),
                        content: Vec::new(),
                        concept_id: None,
                    })
                    .collect(),
                "0.1.0",
                "0.1",
                "knowledge",
                "2026-07-07T00:00:00Z",
                ManifestSource {
                    git_commit: None,
                    git_remote: None,
                    dirty: None,
                },
            )
        };

        for path in [
            "",
            "../outside.md",
            "/absolute.md",
            "C:/absolute.md",
            "a/./b.md",
            "a\0b.md",
            "CON.md",
            "dir/aux.txt",
            "bad?.md",
            "trailing.",
            "trailing ",
        ] {
            assert!(matches!(
                metadata_for(&[path]),
                Err(PackError::InvalidPath { .. })
            ));
        }
        assert_eq!(
            metadata_for(&["a.md", ".\\a.md"]),
            Err(PackError::DuplicatePath {
                path: "a.md".to_string()
            })
        );
        assert!(matches!(
            metadata_for(&["Case.md", "case.md"]),
            Err(PackError::DuplicatePath { .. })
        ));
        assert!(matches!(
            metadata_for(&["Caf\u{e9}.md", "Cafe\u{301}.md"]),
            Err(PackError::DuplicatePath { .. })
        ));
    }
}
