---
type: architecture
title: okfx Producer Adapters
description: Local producer adapters and reviewable-file workflow.
owner: NEEDS_OWNER
status: proposed
tags:
  - adapters
  - imports
---

# okfx Producer Adapters

## Rule

Producer adapters generate reviewable Markdown files. They MUST NOT silently
mutate existing knowledge or publish generated content without human review.

## Current Packages

- `@okfx/adapter-markdown`
- `@okfx/adapter-openapi`
- `@okfx/adapter-dbt`
- `@okfx/adapter-datahub`
- `@okfx/adapter-bigquery`

## Verification

- Adapter tests under `packages/adapter-*/test/`.
- Review workflow: run `okf fmt`, `okf validate`, and `okf lint` after writing drafts.
