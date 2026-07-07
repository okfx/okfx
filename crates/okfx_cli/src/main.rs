use std::env;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

const OKFX_VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> ExitCode {
    match run(env::args().skip(1).collect()) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("okfx: {error}");
            ExitCode::from(2)
        }
    }
}

fn run(args: Vec<String>) -> Result<ExitCode, String> {
    let Some(command) = args.first().map(String::as_str) else {
        print_help();
        return Ok(ExitCode::SUCCESS);
    };

    match command {
        "-h" | "--help" | "help" => {
            print_help();
            Ok(ExitCode::SUCCESS)
        }
        "-V" | "--version" | "version" => {
            println!("okfx {OKFX_VERSION}");
            Ok(ExitCode::SUCCESS)
        }
        "parse" => parse_command(&args[1..]),
        "fmt" => fmt_command(&args[1..]),
        "rules" => rules_command(&args[1..]),
        other => Err(format!("unknown command \"{other}\"")),
    }
}

fn parse_command(args: &[String]) -> Result<ExitCode, String> {
    let path = single_path_arg("parse", args)?;
    let content = read_to_string(path)?;
    let source_concept_id = concept_id_from_path(path);
    let parsed = okfx_parser::parse_markdown_document(path, content, source_concept_id);
    print_json(&parsed)?;
    Ok(exit_for_diagnostics(parsed.diagnostics.iter().map(
        |diagnostic| matches!(diagnostic.severity, okfx_parser::DiagnosticSeverity::Error),
    )))
}

fn fmt_command(args: &[String]) -> Result<ExitCode, String> {
    let check = args.iter().any(|arg| arg == "--check");
    let paths = args
        .iter()
        .filter(|arg| arg.as_str() != "--check")
        .collect::<Vec<_>>();
    let Some(path) = paths.first() else {
        return Err("fmt requires <path>".to_string());
    };
    if paths.len() > 1 {
        return Err("fmt accepts exactly one <path>".to_string());
    }

    let content = read_to_string(path)?;
    let result = okfx_fmt::format_markdown_document(path.as_str(), &content);
    if !result.diagnostics.is_empty() {
        for diagnostic in result.diagnostics {
            eprintln!(
                "{} {}",
                diagnostic.code,
                diagnostic.path.unwrap_or_else(|| path.to_string())
            );
        }
        return Ok(ExitCode::from(1));
    }

    if check {
        if result.changed {
            eprintln!("{} needs formatting", path);
            return Ok(ExitCode::from(1));
        }
        return Ok(ExitCode::SUCCESS);
    }

    if result.changed {
        fs::write(path, result.formatted)
            .map_err(|error| format!("failed to write {path}: {error}"))?;
    }
    Ok(ExitCode::SUCCESS)
}

fn rules_command(args: &[String]) -> Result<ExitCode, String> {
    let path = single_path_arg("rules", args)?;
    let content = read_to_string(path)?;
    let input = serde_json::from_str::<okfx_rules::RuleInput>(&content)
        .map_err(|error| format!("failed to parse rule input {path}: {error}"))?;
    let diagnostics = okfx_rules::run_builtin_rules(input);
    print_json(&diagnostics)?;
    Ok(exit_for_diagnostics(diagnostics.iter().map(|diagnostic| {
        diagnostic.severity == okfx_rules::Severity::Error
    })))
}

fn single_path_arg<'a>(command: &str, args: &'a [String]) -> Result<&'a str, String> {
    match args {
        [path] => Ok(path),
        [] => Err(format!("{command} requires <path>")),
        _ => Err(format!("{command} accepts exactly one <path>")),
    }
}

fn read_to_string(path: impl AsRef<Path>) -> Result<String, String> {
    let path = path.as_ref();
    fs::read_to_string(path).map_err(|error| format!("failed to read {}: {error}", path.display()))
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize JSON output: {error}"))?;
    println!("{json}");
    Ok(())
}

fn exit_for_diagnostics(errors: impl IntoIterator<Item = bool>) -> ExitCode {
    if errors.into_iter().any(|is_error| is_error) {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn concept_id_from_path(path: &str) -> String {
    let normalized = path.replace('\\', "/").trim_start_matches("./").to_string();
    normalized
        .strip_suffix(".md")
        .unwrap_or(&normalized)
        .to_string()
}

fn print_help() {
    println!(
        "okfx {OKFX_VERSION}

Usage:
  okfx parse <path>
  okfx fmt [--check] <path>
  okfx rules <input-json>
  okfx --version
"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reports_version() {
        assert_eq!(
            run(vec!["--version".to_string()]).unwrap(),
            ExitCode::SUCCESS
        );
    }

    #[test]
    fn rejects_unknown_command() {
        assert!(run(vec!["unknown".to_string()]).is_err());
    }

    #[test]
    fn checks_formatting() {
        let path = temp_file("format", "---\ntitle: Example\ntype: Note\n---\n# Example");
        let code = run(vec!["fmt".to_string(), "--check".to_string(), path.clone()]).unwrap();
        assert_eq!(code, ExitCode::from(1));
        fs::remove_file(path).unwrap();
    }

    fn temp_file(name: &str, content: &str) -> String {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("okfx-cli-{name}-{suffix}.md"));
        fs::write(&path, content).unwrap();
        path.to_string_lossy().to_string()
    }
}
