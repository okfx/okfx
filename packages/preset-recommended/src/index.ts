import type { OkfxConfig } from "@okfx/core";

const preset: OkfxConfig = {
  rules: {
    "spec/missing-type": "error",
    "spec/invalid-frontmatter": "error",
    "hygiene/missing-title": "warning",
    "hygiene/missing-description": "warning",
    "hygiene/empty-body": "warning",
    "graph/broken-internal-link": "warning",
    "graph/orphan-concept": "advice",
    "security/suspicious-secret": "error"
  }
};

export default preset;
