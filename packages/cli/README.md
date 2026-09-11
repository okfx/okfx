# okfx

Command-line interface for [okfx](https://github.com/okfx/okfx) — the developer toolkit
for Open Knowledge Format (OKF) bundles. Installs the `okf` command.

## Install

```bash
pnpm add -g okfx
# or
pnpm dlx okfx --help
```

## Usage

```bash
okf init ./knowledge --template data-platform   # scaffold a starter bundle
okf validate ./knowledge                         # hard OKF conformance
okf lint ./knowledge                             # quality, graph, style, security rules
okf fmt ./knowledge                              # format frontmatter + Markdown
okf graph ./knowledge --format json --out g.json # build the concept graph
okf doctor ./knowledge                           # agent-readiness score
okf diff ./before ./after                        # semantic diff
okf pack ./knowledge                             # portable artifact + manifest
okf index ./knowledge                            # local full-text index
okf import dbt --input manifest.json --out ./kb  # produce reviewable OKF drafts
okf export static-site ./knowledge --out ./site  # export to a consumer surface
okf mcp ./knowledge                              # read-only MCP server for agents
```

Every command accepts a bundle root (default `.`).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Diagnostics/diff/format differences crossed the failure threshold. |
| `2` | Invalid config, arguments, or runtime failure. |
| `3` | Plugin load or execution failure. |

## Documentation

- [Command reference](https://github.com/okfx/okfx/blob/main/docs/commands/reference.md)
- [Configuration](https://github.com/okfx/okfx/blob/main/docs/config/reference.md)
- [Rule catalog](https://github.com/okfx/okfx/blob/main/docs/rules/catalog.md)
- [Project README](https://github.com/okfx/okfx#readme)

## License

[MIT](https://github.com/okfx/okfx/blob/main/LICENSE)
