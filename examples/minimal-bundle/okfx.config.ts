export default {
  okfVersion: "0.1",
  include: ["**/*.md"],
  exclude: ["node_modules/**", ".git/**", ".okfx/**", "dist/**"],
  presets: ["recommended", "agent-ready"],
  failOn: "error",
  frontmatter: {
    keyOrder: ["type", "title", "description", "resource", "tags", "timestamp"]
  },
  mcp: {
    readonly: true,
    exposeDiagnostics: true,
    exposeGraph: true
  }
};
