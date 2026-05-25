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

# Rebuilds only the custom `workspace-storage` extension (esbuild)
npm run build:ext

# Runs only the Open VSX fetch/unpack step
npm run build:extensions
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
- Check for updates: `npm run check:extensions` reports outdated extensions.

### VS Code

Pinned via the `vscode-web` dependency in `package.json`.

To update, bump it and `npm install`; `npm run build` flattens
`node_modules/vscode-web/dist/*` into `dist/vscode/`.

### Theme

1. Add theme extension to `config/extensions.config.json`.
2. Update the `config/product.template.json` file

```json
"configurationDefaults": { "workbench.colorTheme": "micro:bit Pixel Light" }
```
