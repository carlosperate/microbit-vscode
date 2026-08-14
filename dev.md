# Dev notes

## npm scripts

```sh
npm run build
npm run dev
```

```sh
# Runs the `vitest` unit suite once
npm test

# Same suite, re-running on every file change
npm run test:watch

# Rebuilds only the local extensions authored in this repo (esbuild)
npm run build:local-extensions

# Runs only the Open VSX fetch/unpack step
npm run fetch:openvsx-extensions

# Builds the vscode-web bundle from VS Code source (uses Docker)
npm run build:vscode
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

### Theme

1. Add theme extension to `config/extensions.config.json`.
2. Update the `config/product.template.json` file

```json
"configurationDefaults": { "workbench.colorTheme": "micro:bit Pixel Light" }
```

### VS Code

`npm run build` consumes the web bundle from `.cache/vscode-web/`.

If it's not there, the build script downloads it from a GH Release from this
repository with the version specified in `config/vscode-web.config.json`,
which can also be done with `npm run fetch:vscode`.

If `.cache/vscode-web/` is already present and the version in its
`package.json` matches the configured version it is used as-is.

So, a local VS Code source build (`npm run build:vscode`) can also create the
bundle locally in `.cache/vscode-web/` for consumption by the build.

To update the VS Code version used, update it from the `config/vscode-web.config.json`
`vscodeVersion` field. You can build it locally via `npm run build:vscode`
and once everything is tested and ready, it has to be published as a GH release
in a tag named `vscode-web-vX.Y.Z`, so that future builds can fetch it.

#### Building VS Code from source

The normal path is to run `npm run build:vscode`.

A docker image fetches the `microsoft/vscode` source code at the version pinned
in `config/vscode-web.config.json`, and the final build goes into
`.cache/vscode-web/`.

> [!WARNING]
> **Give Docker ≥9 GB RAM.** `gulp vscode-web-min` runs Node with an 8 GB heap
> and a memory-hungry mangler pass. On a smaller Docker VM the build GC-thrashes
> and appears to hang at the `compile-src`/mangler step.

Alternatively the `npm run build:old-vscode-web` script runs the older build
pipeline fetching the pre-compiled VS Code v1.91.1 bundle included
by the `vscode-web` npm package from `Felx-B/vscode-web`.

## Testing over https

Some extensions load from a public `*.vscode-cdn.net` webview, and Chrome
blocks it due to CORS policy from a local server. Expose the dev server via
a public tunnel to reproduce the deployed https setup:

```sh
npm run dev
cloudflared tunnel --url http://localhost:8080
```

Open the printed `https://<random>.trycloudflare.com` URL, not `localhost`.
