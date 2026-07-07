import type { OkfxConfig } from "@okfx/core";

const preset: OkfxConfig = {
  failOn: "warning",
  rules: {
    "hygiene/missing-title": "error",
    "hygiene/missing-description": "error",
    "hygiene/empty-body": "error",
    "graph/broken-internal-link": "error",
    "graph/no-backlinks": "warning",
    "style/frontmatter-key-order": "warning",
    "style/timestamp-format": "warning",
    "security/private-url": "warning",
    "security/non-allowlisted-resource": "error"
  }
};

export default preset;
