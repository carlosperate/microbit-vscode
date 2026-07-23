#!/usr/bin/env node
import { cp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAndUnpackExtensions } from './fetch-openvsx.mjs';
import { buildLocalExtensions } from './build-local-extensions.mjs';
import { fetchVscodeWeb } from './fetch-vscode-web.mjs';
import { stripExternalSourceMappingUrls } from './strip-sourcemap-urls.mjs';
import {
	patchWebviewOriginCheck,
	computeInlineScriptCspHash,
	readDeclaredScriptCspHash,
	hasCspScriptHash,
	hasUnpatchedGuard,
} from './patch-webview-origin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const publicDir = path.join(root, 'public');
const productTemplate = path.join(root, 'config', 'product.template.json');

/**
 * Pick the vscode-web bundle to build against.
 *
 * Default: the local source build at .cache/vscode-web.
 * `--vscode-web-npm` opts into the legacy `vscode-web` npm package.
 */
function resolveVscodeWebSource(useNpm) {
	const dir = useNpm
		? path.join(root, 'node_modules', 'vscode-web', 'dist')
		: path.join(root, '.cache', 'vscode-web');
	const pkgPath = useNpm
		? path.join(root, 'node_modules', 'vscode-web', 'package.json')
		: path.join(dir, 'package.json');
	const label = useNpm
		? 'node_modules/vscode-web (npm package)'
		: '.cache/vscode-web (local source build)';

	if (!existsSync(dir)) {
		console.error(
			`vscode-web source not found: ${path.relative(root, dir)}/\n` +
			(useNpm
				? 'Run `npm install` to restore the vscode-web npm package.'
				: 'Build it with `npm run build:vscode`.')
		);
		process.exit(1);
	}
	return { dir, pkgPath, label };
}

/** Wipe and recreate dist/. */
async function resetDist() {
	await rm(dist, { recursive: true, force: true });
	await mkdir(dist, { recursive: true });
}

/** Copy the vscode-web bundle into dist/vscode/ and the public/ shell into dist/. */
async function copyStaticAssets(vscodeWebDir) {
	console.log('Copying vscode-web → dist/vscode/');
	await cp(vscodeWebDir, path.join(dist, 'vscode'), { recursive: true });
	console.log('Copying public/ → dist/');
	await cp(publicDir, dist, { recursive: true });
}

/** Recursively yield every file path under `dir`. */
async function* walkFiles(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkFiles(full);
		else if (entry.isFile()) yield full;
	}
}

// The webview bootstrap files we patch. `index.html` is mandatory — if it's
// gone our webviews are broken, so its absence is a hard build failure. The
// `-no-csp` sibling is best-effort (patched if present).
const WEBVIEW_PRE_FILES = ['index.html', 'index-no-csp.html'];
// A looser match than the strip pattern (tolerates spacing/quote drift, and
// matches absolute or protocol-relative URLs) used to double-check nothing
// slipped through — an independent backstop, not a copy.
const EXTERNAL_SOURCEMAP_RE = /sourceMappingURL\s*=\s*['"]?(?:https?:)?\/\//;

/**
 * Sever the copied vscode-web bundle's two dependencies on Microsoft's CDN:
 *
 * 1. `//# sourceMappingURL=https://main.vscode-cdn.net/…` trailers on ~47 JS
 *    files whose `.map` we never ship — dead 504 requests with DevTools open.
 * 2. The webview bootstrap's parent-origin check (`pre/index.html`,
 *    `pre/index-no-csp.html`) that only trusts wildcard `*.vscode-cdn.net`
 *    hostnames — patched to also trust same-origin webviews, since we self-host
 *    the `pre/` assets (see webviewEndpoint in public/index.html).
 *
 * Each patch is followed immediately by an assertion that its intended invariant
 * actually holds in the output, so a patch that silently does nothing (stale
 * anchor, moved folder, drifted format) fails the build loudly rather than
 * shipping broken webviews. This mirrors the workbench.ts patch's discipline —
 * when bumping vscodeVersion and a throw fires, see WORKBENCH_PATCH.md →
 * "Maintaining the bundle patches".
 */
async function patchVscodeBundle() {
	console.log('Patching vscode-web bundle (sourcemap URLs + webview origin check)');
	const vscodeDir = path.join(dist, 'vscode');

	// (1) Strip dead absolute sourcemap trailers, verifying none survive.
	let stripped = 0;
	const leaks = [];
	for await (const file of walkFiles(vscodeDir)) {
		if (!file.endsWith('.js') && !file.endsWith('.css')) continue;
		const before = await readFile(file, 'utf8');
		const after = stripExternalSourceMappingUrls(before);
		if (after !== before) {
			await writeFile(file, after);
			stripped++;
		}
		if (EXTERNAL_SOURCEMAP_RE.test(after)) leaks.push(path.relative(vscodeDir, file));
	}
	if (leaks.length) {
		throw new Error(
			`patch verify: ${leaks.length} file(s) still carry an absolute sourceMappingURL after stripping ` +
			`(e.g. ${leaks[0]}). The strip pattern is stale for this vscodeVersion — update ` +
			'build-scripts/strip-sourcemap-urls.mjs (see WORKBENCH_PATCH.md).'
		);
	}
	console.log(`  stripped external sourceMappingURL from ${stripped} file(s)`);

	// (2) Widen the webview parent-origin guard (+ re-sync its CSP hash).
	const preDir = path.join(vscodeDir, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre');
	const [required] = WEBVIEW_PRE_FILES;
	if (!existsSync(path.join(preDir, required))) {
		throw new Error(
			`patch-webview-origin: ${required} not found under ${path.relative(root, preDir)} — ` +
			'upstream VS Code moved the webview bootstrap folder; rebase this patch (see WORKBENCH_PATCH.md).'
		);
	}
	let patched = 0;
	for (const name of WEBVIEW_PRE_FILES) {
		const file = path.join(preDir, name);
		if (!existsSync(file)) continue;
		const before = await readFile(file, 'utf8');
		const after = patchWebviewOriginCheck(before); // throws if the guard anchor is gone
		if (after !== before) {
			await writeFile(file, after);
			patched++;
		}
	}
	assertWebviewPatched(await readFile(path.join(preDir, required), 'utf8'), required);
	console.log(`  patched webview origin check in ${patched} file(s); CSP hash in sync`);
}

/** Assert the patched webview bootstrap carries our bypass and a matching CSP hash. */
function assertWebviewPatched(html, name) {
	if (!html.includes('parentOrigin === location.origin')) {
		throw new Error(
			`patch verify: ${name} is missing the same-origin webview bypass after patching. ` +
			'The parent-origin guard changed shape upstream — rebase build-scripts/patch-webview-origin.mjs ' +
			'(see WORKBENCH_PATCH.md).'
		);
	}
	if (hasUnpatchedGuard(html)) {
		throw new Error(
			`patch verify: ${name} still contains an un-patched origin guard after patching (a duplicate guard ` +
			'upstream?) — rebase build-scripts/patch-webview-origin.mjs (see WORKBENCH_PATCH.md).'
		);
	}
	// If this doc pins an inline script via CSP, that hash MUST be readable and
	// match the (patched) script. An unreadable-but-present CSP hash is a hard
	// failure, not a skip — otherwise an ordering/shape change upstream would ship
	// a blank webview silently. The raw regex is an independent presence check, so
	// even a parse regression in the applier's CSP handling trips this.
	const cspHashPresent = hasCspScriptHash(html) || /script-src[^;"]*'sha256-/.test(html);
	if (cspHashPresent) {
		const declared = readDeclaredScriptCspHash(html);
		const expected = computeInlineScriptCspHash(html);
		if (declared === null || expected === null || declared !== expected) {
			throw new Error(
				`patch verify: ${name} CSP script-src hash (${declared}) does not match its inline script ` +
				`(${expected}). The CSP re-sync in patch-webview-origin.mjs failed for this vscodeVersion ` +
				'(see WORKBENCH_PATCH.md).'
			);
		}
	}
}

/** Render config/product.template.json → dist/product.json (version + bundled extensions). */
async function writeProductJson(vscodeWebVersion, extensionRefs) {
	console.log('Generating dist/product.json');
	const product = JSON.parse(await readFile(productTemplate, 'utf8'));
	product.productConfiguration = {
		...product.productConfiguration,
		version: vscodeWebVersion,
	};
	product.additionalBuiltinExtensions = [
		...(product.additionalBuiltinExtensions ?? []),
		...extensionRefs,
	];
	await writeFile(path.join(dist, 'product.json'), JSON.stringify(product, null, '\t') + '\n');
}

async function main(argv = process.argv.slice(2)) {
	const useNpmVscodeWeb = argv.includes('--vscode-web-npm');
	// Default path: make sure .cache/vscode-web exists and matches the pinned
	// version before we try to consume it. Skipped for the npm build route
	// (--vscode-web-npm), which has its own source under node_modules/.
	if (!useNpmVscodeWeb) {
		await fetchVscodeWeb();
	}
	const vscodeWeb = resolveVscodeWebSource(useNpmVscodeWeb);
	const vscodeWebPkg = JSON.parse(await readFile(vscodeWeb.pkgPath, 'utf8'));
	console.log(`vscode-web source: ${vscodeWeb.label} @ ${vscodeWebPkg.version}`);

	await resetDist();
	await copyStaticAssets(vscodeWeb.dir);
	await patchVscodeBundle();

	console.log('Building local extensions:');
	const localExtensionRefs = await buildLocalExtensions();

	console.log('Fetching Open VSX extensions:');
	const openvsxExtensionRefs = await fetchAndUnpackExtensions();

	await writeProductJson(vscodeWebPkg.version, [...localExtensionRefs, ...openvsxExtensionRefs]);

	console.log('Build complete 🚀');
}

await main();
