import { main } from "../packages/cli/dist/index.js";

const bundles = [
  ".",
  "examples/minimal-bundle",
  "examples/data-platform-bundle",
  "examples/api-bundle",
  "examples/metric-bundle"
];

for (const bundle of bundles) {
  for (const args of [["validate", bundle], ["lint", bundle], ["fmt", bundle, "--check"]]) {
    const exitCode = await main(args);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}
