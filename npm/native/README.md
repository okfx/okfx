# okfx Native Package Templates

These package manifests are release templates for prebuilt N-API artifacts.
They are intentionally outside the root npm workspace so local development does
not install every platform package.

Release packaging should copy the matching `okfx_napi.node` artifact into one
of these directories, run `npm pack`, then publish the package with the same
version as `@okfx/core`.

The `@okfx/core` runtime loader probes the platform package first and then falls
back to `@okfx/native`, local development artifacts, WASM, and TypeScript.
