# Distribution

okfx publishes a TypeScript-first toolchain with optional native acceleration.
Packages are published to the npm registry; the recommended package manager is
pnpm:

```bash
pnpm add -g @okfx/cli
```

The `okf` command and regular `@okfx/core` APIs use TypeScript and work without
native artifacts. Core's async `*Accelerated` helpers first try a matching N-API
package, then a generic/local native artifact, then WASM, and finally TypeScript.
Backend packages are optional and must be installed alongside `@okfx/core`.

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

1. Build TypeScript packages with `pnpm build`.
2. Run `cargo test --workspace`.
3. Build `okfx_napi.node` for each native target.
4. Copy each binary into its matching `npm/native/*` template directory.
5. Build the WASM package artifacts from `crates/okfx_wasm`.
6. Run `pnpm pack --dry-run` in every package directory.
7. Publish platform packages before publishing `@okfx/core` and `@okfx/cli`.

Native and WASM packages must use the same version as `@okfx/core`. If no optional
package matches the current runtime, accelerated helpers use TypeScript.

## Automation

- `.github/workflows/ci.yml` runs pnpm build, typecheck, tests, audit, Rust tests,
  WASM build, and standalone CLI build on pushes and pull requests.
- `.github/workflows/release.yml` runs on `v*` tags, repeats the full source
  verification, dry-runs every pnpm package archive, and stages standalone
  `okfx` binaries for Linux, macOS arm64, and Windows x64. It creates the
  GitHub Release only after every gate and binary build succeeds.
