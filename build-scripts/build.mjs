#!/usr/bin/env node
import { cp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAndUnpackExtensions } from './fetch-openvsx.mjs';
import { buildLocalExtensions } from './build-local-extensions.mjs';
import { fetchVscodeWeb } from './fetch-vscode-web.mjs';
import { profileFromLayout } from './layout-profile.mjs';
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
const layoutConfig = path.join(root, 'config', 'layout.config.json');

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

// A looser match than the strip pattern (tolerates spacing/quote drift, and
// matches absolute or protocol-relative URLs) used to double-check nothing
// slipped through. An independent backstop, not a copy.
const EXTERNAL_SOURCEMAP_RE = /sourceMappingURL\s*=\s*['"]?(?:https?:)?\/\//;

/**
 * Cut the copied bundle's two ties to Microsoft's CDN: sourcemap links to maps we
 * never ship, and a webview guard that only trusts `*.vscode-cdn.net`. Each patch
 * asserts its own result, so one that silently did nothing fails the build.
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
			`(e.g. ${leaks[0]}). The strip pattern is stale for this vscodeVersion, update ` +
			'build-scripts/strip-sourcemap-urls.mjs.'
		);
	}
	console.log(`  stripped external sourceMappingURL from ${stripped} file(s)`);

	// (2) Widen the webview parent-origin guard (+ re-sync its CSP hash).
	const preIndex = path.join(vscodeDir, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre', 'index.html');
	if (!existsSync(preIndex)) {
		throw new Error(
			`patch-webview-origin: ${path.relative(root, preIndex)} not found. ` +
			'Upstream VS Code moved the webview bootstrap folder; update preIndex in patchVscodeBundle().'
		);
	}
	const patchedIndex = patchWebviewOriginCheck(await readFile(preIndex, 'utf8')); // throws if the guard anchor is gone
	await writeFile(preIndex, patchedIndex);
	assertWebviewPatched(patchedIndex);
	console.log('  patched the webview origin check; CSP hash in sync');
}

/** Assert the patched webview bootstrap carries our bypass and a matching CSP hash. */
function assertWebviewPatched(html) {
	if (!html.includes('parentOrigin === location.origin')) {
		throw new Error(
			'patch verify: pre/index.html is missing the same-origin webview bypass after patching. ' +
			'The parent-origin guard changed shape upstream; rebase build-scripts/patch-webview-origin.mjs.'
		);
	}
	if (hasUnpatchedGuard(html)) {
		throw new Error(
			'patch verify: pre/index.html still contains an un-patched origin guard after patching (a duplicate guard ' +
			'upstream?). Rebase build-scripts/patch-webview-origin.mjs.'
		);
	}
	// If this doc pins an inline script via CSP, that hash MUST be readable and
	// match the (patched) script. An unreadable-but-present CSP hash is a hard
	// failure, not a skip. Otherwise an ordering/shape change upstream would ship
	// a blank webview silently. The raw regex is an independent presence check, so
	// even a parse regression in the applier's CSP handling trips this.
	const cspHashPresent = hasCspScriptHash(html) || /script-src[^;"]*'sha256-/.test(html);
	if (cspHashPresent) {
		const declared = readDeclaredScriptCspHash(html);
		const expected = computeInlineScriptCspHash(html);
		if (declared === null || expected === null || declared !== expected) {
			throw new Error(
				`patch verify: pre/index.html CSP script-src hash (${declared}) does not match its inline script ` +
				`(${expected}). The CSP re-sync in patch-webview-origin.mjs failed for this vscodeVersion.`
			);
		}
	}
}

/** Render config/product.template.json → dist/product.json (version + bundled extensions). */
async function writeProductJson(vscodeWebVersion, extensionRefs, enabledApiProposals = {}) {
	console.log('Generating dist/product.json');
	const product = JSON.parse(await readFile(productTemplate, 'utf8'));
	product.productConfiguration = {
		...product.productConfiguration,
		version: vscodeWebVersion,
		extensionEnabledApiProposals: {
			...product.productConfiguration?.extensionEnabledApiProposals,
			...enabledApiProposals,
		},
	};
	product.additionalBuiltinExtensions = [
		...(product.additionalBuiltinExtensions ?? []),
		...extensionRefs,
	];
	// index.html passes the profile through to the workbench options.
	const profile = profileFromLayout(JSON.parse(await readFile(layoutConfig, 'utf8')));
	if (profile) product.profile = profile;
	await writeFile(path.join(dist, 'product.json'), JSON.stringify(product, null, '\t') + '\n');
}

async function main() {
	// Throws unless .cache/vscode-web ends up holding the pinned version.
	const vscodeWeb = await fetchVscodeWeb();

	await resetDist();
	await copyStaticAssets(vscodeWeb.dir);
	await patchVscodeBundle();

	console.log('Building local extensions:');
	const local = await buildLocalExtensions();

	console.log('Fetching Open VSX extensions:');
	const openvsxExtensionRefs = await fetchAndUnpackExtensions(vscodeWeb.version);

	await writeProductJson(vscodeWeb.version, [...local.refs, ...openvsxExtensionRefs], local.proposals);

	console.log('Build complete 🚀');
}

await main();
