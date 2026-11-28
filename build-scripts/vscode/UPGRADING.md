# Upgrading VS Code

What this repo depends on inside VS Code, and what to check when `vscodeVersion` changes in
`config/vscode-web.config.json`. Last reconciled against **1.103.2**.

## The steps

1. Set `vscodeVersion` to the new `microsoft/vscode` tag and `sha256` to `null`. Move the two
   local extensions (`src/extensions/*/package.json` → `engines.vscode`) and `@types/vscode` in
   `package.json` to the same version, so they are written against what they run on.
2. `npm run build:vscode`. Docker clones that tag, builds it and leaves the bundle in
   `.cache/vscode-web/`. If it fails, see [The source build](#the-source-build).
3. `npm test`. `test/vscode-bundle.test.mjs` checks what this repo takes from the bundle by name
   and does not patch: the paths the page names, VS Code's storage names, the proposed APIs. It
   needs the bundle in `.cache/vscode-web/`: with none there it is skipped, except in CI, and
   with another version there it fails.
4. `npm run build`. It throws (`patch verify`, `patch-webview-origin`) when one of its two patches
   no longer fits the new bundle. The sections below say what to do for each.
5. `npm run dev:serve` and check in Chrome, Firefox and Safari, reading the console:
   - it boots with no 404, 504 or Content Security Policy error, and every bundled extension is
     active (none reported as "Skipping invalid additional builtin extension");
   - a webview renders (the welcome page);
   - a mode switch hides the other language's activity bar icon;
   - a storage switch and a reload keep the files;
   - a fresh profile has the seeded layout, and nothing new in the interface that a learner
     should not see;
   - a profile that used browser storage on the previous version still opens with its files.
6. Commit, tag that commit `vscode-web-v<version>` and **push the tag only**. A push to `main`
   deploys, and until the release exists the deploy has nothing to fetch. The tag's workflow
   builds in Docker and publishes `vscode-web-v<version>.zip` with its `.sha256`.
7. Move `.cache/vscode-web` aside, `npm run build` to fetch the release, and repeat the browser
   checks on it: it is a different build from the local one. Then set `sha256` from the release's
   `.sha256`, commit, and push `main`.

**A bundled extension must not ask for a newer VS Code than this one.** VS Code skips any
extension whose `engines.vscode` is above its own version, built in or not. Extensions with an
older floor load fine, so the IDE moves first and the pins in `config/extensions.config.json`
follow. `npm run build` fails on such an Open VSX pin.

## What depends on VS Code

| What | Where it lives here | Compare upstream at the new tag |
|---|---|---|
| The source build | `build-vscode.mjs`, `Dockerfile` | `.nvmrc`, `build/npm/preinstall.*`, `build/gulpfile.vscode.web.*`, `build/gulpfile.compile.*` |
| The page that starts VS Code | `public/index.html` | `src/vs/code/browser/workbench/workbench.html`, `src/vs/workbench/workbench.web.main.internal.ts`, `src/vs/workbench/browser/web.api.ts` |
| Webviews served from our own origin | `build.mjs` → `patchVscodeBundle()`, `patch-webview-origin.mjs` | `src/vs/workbench/contrib/webview/browser/pre/index.html` |
| Webviews in Firefox, which leaves a frame mounted blank uncontrolled by the webview service worker | `public/index.html` → `remountBlankWebviews` re-inserts it | `src/vs/workbench/contrib/webview/browser/webviewElement.ts` (`mountTo`, `_initElement`, and messages matched by `target` and origin rather than window). In Firefox, the welcome page must render after a reload and after its tab is shown again |
| Dead sourcemap links | `build.mjs` → `patchVscodeBundle()`, `strip-sourcemap-urls.mjs` | the last line of any file under `out/` |
| Pinning activity bar icons | `public/index.html` → `setPinned`, checked in `test/vscode-bundle.test.mjs` | `src/vs/workbench/services/storage/browser/storageService.ts`, `src/vs/workbench/browser/parts/activitybar/activitybarPart.ts` |
| The seeded layout | `build-scripts/layout-profile.mjs`, its ids checked in `test/vscode-bundle.test.mjs` | `workbench.explorer.views.state.hidden`, which VS Code builds at runtime: check the Explorer's views in a fresh profile |
| Search in the project, and the folder's `[Temporary]` tag | `workspace-storage`, through three proposed APIs it types by hand (`src/vscode-search.d.ts`, `src/vscode-labels.d.ts`) | `src/vscode-dts/vscode.proposed.fileSearchProvider.d.ts`, `…textSearchProvider.d.ts` and `…resolvers.d.ts` (`workspaceSuffix`). A proposal can change in any release, and upstream already has a `…2` of both search ones |

## The source build

`build-vscode.mjs` runs inside the Docker image: a shallow clone of the tag, `npm ci`, then two of
upstream's own gulp tasks, `compile-build-without-mangling` and `vscode-web-min-ci`. Nothing in the
clone is patched. Gulp leaves the bundle in a `vscode-web` folder beside the clone, which the script
publishes to `.cache/vscode-web/` once its version matches.

- **The package manager is upstream's choice**, and `build/npm/preinstall.*` refuses any other:
  yarn up to 1.93, npm from 1.94 to 1.145, pnpm from 1.146.
- **Node comes from the `Dockerfile`'s image** and must satisfy upstream's `.nvmrc`: 22 at 1.103,
  24 from 1.123.
- **The mangler is left out for memory.** It shortens private names to shrink the bundle. At
  1.103.2 it runs four workers that each load the whole project, more than the 16 GB a GitHub
  runner has: the compile is killed with exit 137. Without it the build takes about 8 minutes and
  7 GiB, and the main bundle is 13.5 MB (3.4 MB gzipped).
- **From 1.139 that mangler is gone.** esbuild bundles the web build and shortens private names
  itself, and `vscode-web-min` has no separate compile step. So from there the two task names
  above change, most likely back to `vscode-web-min` alone, with its memory to measure again.
- A reused clone is kept only while its tag matches `vscodeVersion`.

## The page that starts VS Code

`public/index.html` does what upstream's `workbench.html` does, without the server that page
expects:

1. `globalThis._VSCODE_FILE_ROOT` is the absolute URL of `vscode/out/`. VS Code resolves its
   workers, media and `node_modules` from it.
2. `out/nls.messages.js` is imported first: the workbench reads its strings as it loads.
3. `out/vs/workbench/workbench.web.main.internal.js` is imported, and its `create()` is called
   with our options. Its stylesheet is `workbench.web.main.internal.css`.

The page names those three files, and `test/vscode-bundle.test.mjs` fails when one of them is not
in the bundle, so a renamed file is caught by the tests and not by a learner.

Two `<link rel="modulepreload">` start both downloads early. They need the page's
`importWithRetry()` beside them: Safari reuses a failed preload on every reload and never asks the
server again, so a failed import is tried once more at an address with a query. Check both again
in Safari after an upgrade, by failing the workbench download once and reloading.

When the start fails all the same, `startupFailed()` shows a message and a Reload button in
place of a blank page.

Upstream marks that module's exports as a contract for web embedders, and they are the same from
1.95 to 1.148. The options we pass (`additionalBuiltinExtensions`, `workspaceProvider`,
`webviewEndpoint`, `commands`, `profile`, `configurationDefaults`, `productConfiguration`) are
fields of `IWorkbenchConstructionOptions` in `web.api.ts`.

Upstream's own start-up module, `vs/code/browser/workbench/workbench.js`, is not in the web build
and would not run here: it reads its options from an element a server injects.

`out/vs/loader.js` and the small `workbench.web.main.js` are a bridge for pages written for the
AMD loader. Nothing here loads them, and upstream ships them only up to 1.108.

## The bundle patches

Both run after the bundle is copied into `dist/vscode/`, and both exist because VS Code expects
Microsoft's CDN where we serve everything from one origin. **Neither can be skipped**: without the
first, every webview is dead.

| Patch | Module | What it fixes |
|---|---|---|
| Webview origin guard, and its CSP hash | `patch-webview-origin.mjs` | `pre/index.html` trusts a webview only when its hostname is a hash of the parent origin, a scheme that needs one subdomain per webview. We serve webviews from our own origin (`opts.webviewEndpoint` in `public/index.html`), so the guard also accepts the same origin. The page pins its inline script by sha-256 in its CSP, so the patch recomputes that hash, or the browser blocks the edited script and the webview is blank. |
| Sourcemap links | `strip-sourcemap-urls.mjs` | Files end with `//# sourceMappingURL=https://main.vscode-cdn.net/…` (41 of them at 1.103.2) for maps we do not ship, each a failed request with DevTools open. Absolute links are stripped, relative ones (xterm's) kept. |

The endpoint and the guard patch need each other: no endpoint is a 504 from the CDN, and the
endpoint without the patch is `Expected '<hash>' as hostname or subdomain!`.

Same-origin webviews can reach the workbench's storage, the files in browser storage included.
That is accepted, as code-server accepts it: the IDE has no login and holds no secrets.

### How they stay honest

Upstream reshapes this bundle every release, so each patch has three layers:

1. **It throws when its target is gone.** `patchWebviewOriginCheck()` throws when the guard line
   is missing, and `patchVscodeBundle()` when `pre/index.html` is.
2. **The result is checked, by a looser rule than the one that made it.** After patching, the
   build asserts that no file still has an absolute sourcemap link, that `pre/index.html` has the
   same-origin clause and no unpatched guard, and that its CSP hash equals the hash of its inline
   script. A patch that applied and achieved nothing fails here.
3. **The pure modules have unit tests**, for the transform, for running twice, and for a missing
   anchor.

### When one throws on an upgrade

Do not make these pass by skipping them.

| Message | What changed upstream | What to do |
|---|---|---|
| `…/pre/index.html not found` | the webview folder moved | find it by searching the tag for `parentOriginHash`, and update `preIndex` in `patchVscodeBundle()` |
| `guard anchor not found` | the origin check was rewritten | read the new `pre/index.html`, update `GUARD` and `PATCHED` in `patch-webview-origin.mjs`, and its test |
| `N file(s) still carry an absolute sourceMappingURL` | the link's format changed | widen `stripExternalSourceMappingUrls()` and add the new format to its test |
| `missing the same-origin webview bypass` | the guard matched but the replacement no longer says what we mean | derive the patch again from the new guard |
| `still contains an un-patched origin guard` | a second form of the guard exists | add it beside `GUARD` and `PATCHED` |
| `CSP script-src hash … does not match its inline script` | the guarded script is no longer found by `parentOriginHash`, or the CSP's `script-src` changed shape | adjust `GUARD_SYMBOL`, `scriptSrcDirective` or `CSP_HASH_SOURCE_RE`. In a browser this is a blank webview with a CSP error |
| `CSP script-src declares multiple sha256 sources` | the page now has more than one hashed inline script | decide which one holds the guard and make `syncInlineScriptCsp` target it |

The inline script is hashed after turning CRLF into LF, as browsers do, and it is chosen by the
`parentOriginHash` symbol and not by its position, so an added leading `<script>` cannot shift it.

## Pinning activity bar icons

A mode hides the other language's icon. VS Code has no API for that, so `setPinned` in
`public/index.html` writes VS Code's own state database and announces the change on the
BroadcastChannel VS Code syncs its windows with. `test/vscode-bundle.test.mjs` checks that the
bundle still has what that relies on:

- the database name prefix `vscode-web-state-db-`, its `ItemTable` table, and the `global` store
  that broadcasts changes;
- the key `workbench.activity.pinnedViewlets2`;
- the sync message's shape, `{changed, deleted}`.

The same test checks `vscode-web-db`, the settings database `forgetEditorState` clears for a
temporary session. When one fails, read the two upstream files in the table above and update the
page and the test together. The test reads `out/vs/workbench/workbench.web.main.internal.js`.

## Upstream changes after 1.103.2

Read from upstream's source at each tag, not built here.

| From | Change | What it means here |
|---|---|---|
| 1.109 | the AMD bridge is gone | nothing, the page does not use it |
| 1.123 | Node 24 | the `Dockerfile`'s image |
| 1.139 | esbuild bundles the web build | the gulp task names in `build-vscode.mjs` |
| 1.146 | pnpm replaces npm | the install command in `build-vscode.mjs` |

Unchanged up to 1.148.0: the `vscode-web-min` task and its `vscode-web` output folder, the
internal module and its exports, `nls.messages.js`, the webview guard line, the storage names
above, `workspaceSuffix`, and Copilot's interface hiding itself on a web host with no server.
