# Dev notes

## npm scripts

```sh
npm run build
npm run dev
npm run clean
```

```sh
# Runs the `vitest` unit suite
npm test

# Rebuilds only the local extensions authored in this repo (esbuild)
npm run build:local-extensions

# Runs only the Open VSX fetch/unpack step
npm run build:openvsx-extensions
```

## Open VSX cache & rate limiting

`npm run dev` runs a full `npm run build` first, and as part of that, it checks
configured extensions are downloaded from Open VSX as `.vsix` files
into `.cache/vsix/`.

If no version is specified in `config/extensions.config.json`, the build
script checks if there is a newer version in Open VSX to determine if it
needs to download it. In `npm run dev` this can cause Open VSX rate limiting.

## Updating

### Extensions

- Add: Append `{ "publisher": "...", "name": "..." }` to
  `config/extensions.config.json`, run `npm run build`.
- Pin a version: Add `"version": "x.y.z"` to the entry. Recommended to
  avoid being rate limited by Open VSX during development.
- Check for updates: `npm run check:extensions` reports outdated Open VSX extensions.

### VS Code

Pinned via the `vscode-web` dependency in `package.json`.

To update, bump it and `npm install`; `npm run build` flattens
`node_modules/vscode-web/dist/*` into `dist/vscode/`.

#### Building VS Code from source (`npm run build:vscode`)

Builds the web bundle from `microsoft/vscode` in Docker (version pinned in
`config/vscode-web.config.json`) into `.cache/vscode-web/` (build scratch lives
in `.cache/vscode-build/`). Full docs land later; for now the one thing that bites:

> **Give Docker ≥9 GB RAM.** `gulp vscode-web-min` runs Node with an 8 GB heap
> and a memory-hungry mangler pass. On a smaller Docker VM the build GC-thrashes
> and appears to hang at the `compile-src`/mangler step (CPU busy, no progress).
> Raise it in Docker Desktop → Settings → Resources → Memory. The wrapper warns
> when the VM looks too small.

### Theme

1. Add theme extension to `config/extensions.config.json`.
2. Update the `config/product.template.json` file

```json
"configurationDefaults": { "workbench.colorTheme": "micro:bit Pixel Light" }
```
