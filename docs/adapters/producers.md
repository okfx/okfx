---
type: architecture
title: okfx Producer Adapters
description: Local producer adapters and reviewable-file workflow.
tags:
  - adapters
  - imports
owner: okfx-maintainers
status: proposed
---

# okfx Producer Adapters

## Rule

Producer adapters generate reviewable Markdown files. They MUST NOT silently
mutate existing knowledge or publish generated content without human review.

## Current Packages

Producer packages:

- `@okfxjs/adapter-markdown`
- `@okfxjs/adapter-openapi`
- `@okfxjs/adapter-dbt`
- `@okfxjs/adapter-datahub`
- `@okfxjs/adapter-bigquery`

Consumer packages:

- `@okfxjs/adapter-static-site`

## Consumer Workflow

Consumer adapters export reviewable files. For example:

```bash
okf export static-site ./knowledge --out ./site
okf export static-site ./knowledge --out ./site --write
```

## Verification

- Adapter tests under `packages/adapter-*/test/`.
- Review workflow: run `okf fmt`, `okf validate`, and `okf lint` after writing drafts.
