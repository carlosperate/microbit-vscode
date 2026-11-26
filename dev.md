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

To update the VS Code version used:

1. In `config/vscode-web.config.json` set `vscodeVersion` to the new
   `microsoft/vscode` tag and `sha256` to `null`. Move `engines.vscode` in
   `src/extensions/*/package.json` and `@types/vscode` in `package.json` to
   the same version.
2. `npm run build:vscode` builds it locally (see below).
3. `npm test`. `test/vscode-bundle.test.mjs` checks what this repo takes from
   the bundle by name: the files the page loads, VS Code's storage names and
   the proposed APIs. Fix what a failing test names.
4. `npm run build`. It fails (`patch verify`, `patch-webview-origin`) when one
   of its two patches no longer fits the bundle.
5. `npm run dev` and try it in Chrome, Firefox and Safari.
6. Commit, tag that commit `vscode-web-vX.Y.Z` and push the tag only. The
   tag's workflow builds VS Code and publishes it as a GH release. A push to
   `main` deploys the site, which fails until that release exists.
7. Delete `.cache/vscode-web`, run `npm run build` to fetch the release, and
   try it again. Then set `sha256` from the release's `.sha256` file, commit
   and push `main`.

#### Building VS Code from source

The normal path is to run `npm run build:vscode`.

A docker image fetches the `microsoft/vscode` source code at the version pinned
in `config/vscode-web.config.json`, installs it with npm and runs upstream's own
web build. The final build goes into `.cache/vscode-web/`.

> [!WARNING]
> **Give Docker ≥9 GB RAM.** The compile runs Node with an 8 GB heap and peaked
> at 7 GiB for VS Code 1.103.2. On a smaller Docker VM the build GC-thrashes
> and appears to hang at the `compile-src` step.

## Testing over https

Some extensions load from a public `*.vscode-cdn.net` webview, and Chrome
blocks it due to CORS policy from a local server. Expose the dev server via
a public tunnel to reproduce the deployed https setup:

```sh
npm run dev
cloudflared tunnel --url http://localhost:8080
```

Open the printed `https://<random>.trycloudflare.com` URL, not `localhost`.
