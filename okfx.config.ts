import { defineConfig } from "@okfx/core";

export default defineConfig({
  okfVersion: "0.1",
  include: [
    "docs/**/*.md",
    "examples/**/*.md"
  ],
  exclude: [
    "node_modules/**",
    ".git/**",
    ".okfx/**",
    "dist/**",
    "fixtures/**",
    "fuzz/**",
    "npm/**",
    "plan.md",
    "README.md",
    "CONTRIBUTING.md",
    "packages/**/README.md"
  ],
  presets: ["recommended", "agent-ready"]
});
