use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

pub const CRATE_NAME: &str = "okfx_fs";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryOptions {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub follow_symlinks: bool,
    pub include_dotfiles: bool,
}

impl Default for DiscoveryOptions {
    fn default() -> Self {
        Self {
            include: vec!["**/*.md".to_string()],
            exclude: vec![
                "node_modules/**".to_string(),
                ".git/**".to_string(),
                ".okfx/**".to_string(),
                "dist/**".to_string(),
            ],
            follow_symlinks: false,
            include_dotfiles: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkdownFileKind {
    Concept,
    Index,
    Log,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredFile {
    pub path: String,
    pub kind: MarkdownFileKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsError {
    Io { path: PathBuf, message: String },
    OutsideRoot { root: PathBuf, path: PathBuf },
}

impl fmt::Display for FsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FsError::Io { path, message } => {
                write!(formatter, "I/O error at {}: {message}", path.display())
            }
            FsError::OutsideRoot { root, path } => write!(
                formatter,
                "path {} is outside bundle root {}",
                path.display(),
                root.display()
            ),
        }
    }
}

impl std::error::Error for FsError {}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn resolve_bundle_root(root: impl AsRef<Path>) -> Result<PathBuf, FsError> {
    let root = root.as_ref();
    if root.is_absolute() {
        return Ok(root.to_path_buf());
    }

    std::env::current_dir()
        .map(|cwd| cwd.join(root))
        .map_err(|error| FsError::Io {
            path: root.to_path_buf(),
            message: error.to_string(),
        })
}

pub fn discover_markdown_files(
    root: impl AsRef<Path>,
    options: &DiscoveryOptions,
) -> Result<Vec<String>, FsError> {
    Ok(discover_files(root, options)?
        .into_iter()
        .map(|file| file.path)
        .collect())
}

pub fn discover_files(
    root: impl AsRef<Path>,
    options: &DiscoveryOptions,
) -> Result<Vec<DiscoveredFile>, FsError> {
    let root = resolve_bundle_root(root)?;
    let canonical_root = fs::canonicalize(&root).map_err(|error| FsError::Io {
        path: root.clone(),
        message: error.to_string(),
    })?;
    let mut files = Vec::new();
    let mut visited_directories = BTreeSet::from([canonical_root.clone()]);
    walk_directory(
        &root,
        &canonical_root,
        &root,
        options,
        &mut visited_directories,
        &mut files,
    )?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files.dedup_by(|left, right| left.path == right.path);
    Ok(files)
}

pub fn to_posix_path(path: impl AsRef<str>) -> String {
    path.as_ref().replace('\\', "/")
}

pub fn normalize_relative_path(path: impl AsRef<str>) -> String {
    let path = to_posix_path(path);
    let mut segments = Vec::new();
    let is_absolute = path.starts_with('/');

    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.last().is_some_and(|entry| *entry != "..") {
                    segments.pop();
                } else if !is_absolute {
                    segments.push("..");
                }
            }
            value => segments.push(value),
        }
    }

    let normalized = segments.join("/");
    if is_absolute {
        format!("/{normalized}").trim_end_matches('/').to_string()
    } else {
        normalized
    }
}

pub fn relative_posix_path(
    root: impl AsRef<Path>,
    file_path: impl AsRef<Path>,
) -> Result<String, FsError> {
    let root = root.as_ref();
    let file_path = file_path.as_ref();
    let relative = file_path
        .strip_prefix(root)
        .map_err(|_| FsError::OutsideRoot {
            root: root.to_path_buf(),
            path: file_path.to_path_buf(),
        })?;
    Ok(normalize_relative_path(relative.to_string_lossy()))
}

pub fn concept_id_from_path(path: impl AsRef<str>) -> String {
    let normalized = normalize_relative_path(path);
    normalized
        .strip_suffix(".md")
        .unwrap_or(&normalized)
        .to_string()
}

pub fn is_reserved_markdown_file(path: impl AsRef<str>) -> bool {
    reserved_file_kind(path).is_some()
}

pub fn reserved_file_kind(path: impl AsRef<str>) -> Option<MarkdownFileKind> {
    match basename(path.as_ref()) {
        "index.md" => Some(MarkdownFileKind::Index),
        "log.md" => Some(MarkdownFileKind::Log),
        _ => None,
    }
}

pub fn resolve_markdown_target(
    source_path: impl AsRef<str>,
    target_raw: impl AsRef<str>,
) -> Option<String> {
    let target_raw = target_raw.as_ref();
    let unescaped_target = unescape_markdown_destination(target_raw);
    let without_hash = unescaped_target.split('#').next().unwrap_or_default();
    let without_query = without_hash.split('?').next().unwrap_or_default();
    if without_query.is_empty() {
        return None;
    }

    let decoded_target = decode_percent_runs(without_query);

    let target_path = if let Some(root_relative) = decoded_target.strip_prefix('/') {
        root_relative.to_string()
    } else {
        let source_dir = dirname(&normalize_relative_path(source_path));
        if source_dir.is_empty() {
            decoded_target
        } else {
            format!("{source_dir}/{decoded_target}")
        }
    };

    let normalized = normalize_relative_path(target_path);
    if normalized.starts_with("../") || normalized == ".." || normalized.starts_with('/') {
        return None;
    }

    Some(concept_id_from_path(normalized))
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

fn walk_directory(
    root: &Path,
    canonical_root: &Path,
    directory: &Path,
    options: &DiscoveryOptions,
    visited_directories: &mut BTreeSet<PathBuf>,
    files: &mut Vec<DiscoveredFile>,
) -> Result<(), FsError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| FsError::Io {
            path: directory.to_path_buf(),
            message: error.to_string(),
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| FsError::Io {
            path: directory.to_path_buf(),
            message: error.to_string(),
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let relative = relative_posix_path(root, &path)?;

        if !options.include_dotfiles && contains_dot_segment(&relative) {
            continue;
        }
        if is_excluded(&options.exclude, &relative) {
            continue;
        }

        let canonical_path = if options.follow_symlinks {
            let canonical_path = fs::canonicalize(&path).map_err(|error| FsError::Io {
                path: path.clone(),
                message: error.to_string(),
            })?;
            if !canonical_path.starts_with(canonical_root) {
                return Err(FsError::OutsideRoot {
                    root: canonical_root.to_path_buf(),
                    path,
                });
            }
            Some(canonical_path)
        } else {
            None
        };
        let metadata = if options.follow_symlinks {
            fs::metadata(&path)
        } else {
            fs::symlink_metadata(&path)
        }
        .map_err(|error| FsError::Io {
            path: path.clone(),
            message: error.to_string(),
        })?;

        if metadata.is_dir() {
            if canonical_path
                .is_some_and(|canonical_path| !visited_directories.insert(canonical_path))
            {
                continue;
            }
            walk_directory(
                root,
                canonical_root,
                &path,
                options,
                visited_directories,
                files,
            )?;
            continue;
        }

        if !metadata.is_file() || !is_included(&options.include, &relative) {
            continue;
        }

        files.push(DiscoveredFile {
            kind: reserved_file_kind(&relative).unwrap_or(MarkdownFileKind::Concept),
            path: relative,
        });
    }

    Ok(())
}

fn is_included(patterns: &[String], path: &str) -> bool {
    patterns.iter().any(|pattern| glob_matches(pattern, path))
}

fn is_excluded(patterns: &[String], path: &str) -> bool {
    patterns.iter().any(|pattern| glob_matches(pattern, path))
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern = normalize_relative_path(pattern);
    let path = normalize_relative_path(path);

    if pattern.ends_with("/**") {
        let base = pattern.trim_end_matches("/**");
        if path == base || path.starts_with(&format!("{base}/")) {
            return true;
        }
    }

    let pattern_segments = split_segments(&pattern);
    let path_segments = split_segments(&path);
    match_segments(&pattern_segments, &path_segments)
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    match (pattern.split_first(), path.split_first()) {
        (None, None) => true,
        (None, Some(_)) => false,
        (Some((head, rest)), _) if *head == "**" => {
            match_segments(rest, path) || (!path.is_empty() && match_segments(pattern, &path[1..]))
        }
        (Some((head, rest)), Some((path_head, path_rest))) => {
            segment_matches(head, path_head) && match_segments(rest, path_rest)
        }
        (Some(_), None) => false,
    }
}

fn segment_matches(pattern: &str, value: &str) -> bool {
    segment_matches_inner(
        &pattern.chars().collect::<Vec<_>>(),
        &value.chars().collect::<Vec<_>>(),
    )
}

fn segment_matches_inner(pattern: &[char], value: &[char]) -> bool {
    match (pattern.split_first(), value.split_first()) {
        (None, None) => true,
        (None, Some(_)) => false,
        (Some(('*', rest)), _) => {
            segment_matches_inner(rest, value)
                || (!value.is_empty() && segment_matches_inner(pattern, &value[1..]))
        }
        (Some(('?', rest)), Some((_, value_rest))) => segment_matches_inner(rest, value_rest),
        (Some((pattern_head, rest)), Some((value_head, value_rest))) => {
            pattern_head == value_head && segment_matches_inner(rest, value_rest)
        }
        (Some(_), None) => false,
    }
}

fn split_segments(value: &str) -> Vec<&str> {
    if value.is_empty() {
        Vec::new()
    } else {
        value.split('/').collect()
    }
}

fn contains_dot_segment(path: &str) -> bool {
    path.split('/').any(|segment| segment.starts_with('.'))
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn dirname(path: &str) -> String {
    normalize_relative_path(path)
        .rsplit_once('/')
        .map(|(directory, _)| directory.to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_fs");
    }

    #[test]
    fn normalizes_paths_and_resolves_markdown_targets() {
        assert_eq!(
            normalize_relative_path("./concepts/../metrics/wau.md"),
            "metrics/wau.md"
        );
        assert_eq!(concept_id_from_path("metrics/wau.md"), "metrics/wau");
        assert_eq!(
            reserved_file_kind("docs/index.md"),
            Some(MarkdownFileKind::Index)
        );
        assert_eq!(
            resolve_markdown_target("concepts/metrics/wau.md", "../tables/events.md#schema"),
            Some("concepts/tables/events".to_string())
        );
        assert_eq!(
            resolve_markdown_target("concepts/metrics/wau.md", "/shared/glossary.md"),
            Some("shared/glossary".to_string())
        );
        assert_eq!(
            resolve_markdown_target("concepts/metrics/wau.md", "../../../outside.md"),
            None
        );
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
    }

    #[test]
    fn discovers_markdown_files_with_default_excludes() {
        let root = temp_root("discover-default");
        write(&root, "index.md", "# Index");
        write(&root, "concepts/wau.md", "# WAU");
        write(&root, ".hidden/kept.md", "# Hidden");
        write(&root, "node_modules/pkg/readme.md", "# Ignored");
        write(&root, ".okfx/cache/item.md", "# Ignored");
        write(&root, "dist/out.md", "# Ignored");
        write(&root, "notes.txt", "Ignored");

        let files = discover_files(&root, &DiscoveryOptions::default()).unwrap();
        let paths = files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            paths,
            vec![".hidden/kept.md", "concepts/wau.md", "index.md"]
        );
        assert_eq!(files[2].kind, MarkdownFileKind::Index);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn honors_include_exclude_and_dotfile_options() {
        let root = temp_root("discover-custom");
        write(&root, "concepts/active/a.md", "# A");
        write(&root, "concepts/drafts/b.md", "# B");
        write(&root, ".hidden/c.md", "# C");
        write(&root, "index.md", "# Index");

        let files = discover_markdown_files(
            &root,
            &DiscoveryOptions {
                include: vec!["concepts/**/*.md".to_string(), ".hidden/*.md".to_string()],
                exclude: vec!["concepts/drafts/**".to_string()],
                include_dotfiles: false,
                ..DiscoveryOptions::default()
            },
        )
        .unwrap();

        assert_eq!(files, vec!["concepts/active/a.md"]);

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn contains_followed_symlinks_and_skips_directory_cycles() {
        use std::os::unix::fs::symlink;

        let root = temp_root("discover-symlinks");
        let outside = temp_root("discover-outside");
        write(&root, "inside.md", "# Inside");
        write(&outside, "outside.md", "# Outside");
        symlink(&root, root.join("loop")).unwrap();

        let options = DiscoveryOptions {
            follow_symlinks: true,
            ..DiscoveryOptions::default()
        };
        assert_eq!(
            discover_markdown_files(&root, &options).unwrap(),
            vec!["inside.md"]
        );

        symlink(&outside, root.join("outside")).unwrap();
        assert!(matches!(
            discover_markdown_files(&root, &options),
            Err(FsError::OutsideRoot { .. })
        ));

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_excluded_symlinks_before_following_them() {
        use std::os::unix::fs::symlink;

        let root = temp_root("discover-excluded-symlink");
        let outside = temp_root("discover-excluded-outside");
        write(&root, "inside.md", "# Inside");
        write(&outside, "outside.md", "# Outside");
        symlink(&outside, root.join("node_modules")).unwrap();

        let options = DiscoveryOptions {
            follow_symlinks: true,
            ..DiscoveryOptions::default()
        };
        assert_eq!(
            discover_markdown_files(&root, &options).unwrap(),
            vec!["inside.md"]
        );

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    fn temp_root(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("okfx-fs-{name}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write(root: &Path, path: &str, content: &str) {
        let path = root.join(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }
}
