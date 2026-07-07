---
type: contract
title: okfx MCP Server
description: Read-only MCP server resources, tools, prompts, and safety defaults.
owner: NEEDS_OWNER
status: proposed
tags:
  - mcp
  - agents
---

# okfx MCP Server

## Safety Defaults

The MCP server is read-only, local-only, and stdio-only. It does not register
write tools and does not call external networks or LLMs.

## Tools

- `okf_search_concepts`
- `okf_get_concept`
- `okf_get_neighbors`
- `okf_get_backlinks`
- `okf_get_graph`
- `okf_validate_bundle`
- `okf_lint_bundle`
- `okf_get_diagnostics`

## Resources

- `okf://bundle/current`
- `okf://graph/current`
- `okf://diagnostics/current`
- `okf://concept/{id}`

## Verification

- MCP API tests under `packages/mcp/test/api.test.ts`.
- CLI describe smoke: `npm run okf -- mcp . --describe`.
