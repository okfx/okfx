# okfx fuzzing

This directory contains `cargo-fuzz` targets for parser and resolver hardening.

Run targets from the repository root:

```sh
cargo fuzz run parser
cargo fuzz run resolver
```

The stable regression cases live under `crates/okfx_parser/tests/` and are part
of `cargo test --workspace`.
