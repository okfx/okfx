import type { OkfxConfig } from "@okfxjs/core";

const preset: OkfxConfig = {
  rules: {
    "agent/missing-summary": "advice",
    "agent/missing-usage": "advice",
    "agent/missing-owner": "advice",
    "agent/metric-missing-source": "warning",
    "agent/runbook-missing-symptoms": "warning",
    "agent/api-missing-auth-notes": "advice",
    "graph/no-backlinks": "advice",
    "graph/orphan-concept": "advice"
  }
};

export default preset;
