export const actionName = "okfx";

export const exampleWorkflow = `name: OKF

on:
  pull_request:
  push:
    branches: [main]

jobs:
  okf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: okfx/github-action@v0
        with:
          bundle: ./knowledge
          lint-format: json
          graph-out: okf-graph.json
`;
