use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

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
) -> PackMetadata {
    let okfx_version = okfx_version.into();
    let created_at = created_at.into();
    let mut manifest_files = files
        .into_iter()
        .map(|file| ManifestFile {
            path: normalize_path(&file.path),
            sha256: sha256_hex(&file.content),
            concept_id: file.concept_id,
        })
        .collect::<Vec<_>>();
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

    PackMetadata {
        manifest,
        checksums,
        provenance,
    }
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

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
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
        );

        assert_eq!(metadata.manifest.file_count, 2);
        assert_eq!(metadata.manifest.concept_count, 2);
        assert_eq!(metadata.manifest.files[0].path, "a.md");
        assert_eq!(metadata.checksums.algorithm, "sha256");
        assert_eq!(metadata.checksums.files.len(), 2);
        assert_eq!(metadata.provenance.created_by, "okfx");
        assert_eq!(metadata.manifest.content_hash.len(), 64);
    }
}
