# Distribution

okfx publishes a TypeScript-first toolchain with optional native acceleration.
The default user path remains npm:

```bash
npm install -g @okfx/cli
```

The `okf` command works without native artifacts. `@okfx/core` first tries a
matching N-API package, then a generic native package, then a local development
artifact, then WASM, and finally the TypeScript implementation.

## Native Packages

Platform package names follow the runtime target:

| Package | Target |
| --- | --- |
| `@okfx/core-darwin-arm64` | macOS arm64 |
| `@okfx/core-darwin-x64` | macOS x64 |
| `@okfx/core-linux-x64-gnu` | Linux x64 glibc |
| `@okfx/core-linux-x64-musl` | Linux x64 musl |
| `@okfx/core-win32-x64-msvc` | Windows x64 MSVC |
| `@okfx/native` | Portable/manual native package |

The package templates live under `npm/native`. They are not root workspaces so
development installs do not attempt to install every platform package.

## WASM Packages

The primary WASM package is `@okfx/wasm`. `@okfx/core-wasm` is reserved as a
compatibility alias for package managers or consumers that prefer core-prefixed
names. The package templates live under `npm/wasm` and `npm/core-wasm`.

## Release Checklist

1. Build TypeScript packages with `npm run build`.
2. Run `cargo test --workspace`.
3. Build `okfx_napi.node` for each native target.
4. Copy each binary into its matching `npm/native/*` template directory.
5. Build the WASM package artifacts from `crates/okfx_wasm`.
6. Run `npm pack --dry-run` in every package directory.
7. Publish platform packages before publishing `@okfx/core` and `@okfx/cli`.

Native packages must use the same version as `@okfx/core`. If no native package
matches the current runtime, okfx keeps running through WASM or TypeScript.
