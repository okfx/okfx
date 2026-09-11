# okfx Native Package Templates

These package manifests are release templates for prebuilt N-API artifacts.
They are intentionally outside the root npm workspace so local development does
not install every platform package.

Release packaging should copy the matching `okfx_napi.node` artifact into one
of these directories, run `npm pack`, then publish the package with the same
version as `@okfxjs/core`.

The explicit async acceleration helpers in `@okfxjs/core` probe the platform package
first and then fall back to `@okfxjs/native`, local development artifacts, WASM, and
TypeScript. Regular Core and CLI APIs stay on the TypeScript implementation.
