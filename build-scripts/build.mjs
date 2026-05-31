#!/usr/bin/env node
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAndUnpackExtensions } from './fetch-openvsx.mjs';
import { buildLocalExtensions } from './build-local-extensions.mjs';
import { fetchVscodeWeb } from './fetch-vscode-web.mjs';

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
	console.error('[build] fetchVscodeWeb done, resolving source');
	const vscodeWeb = resolveVscodeWebSource(useNpmVscodeWeb);
	const vscodeWebPkg = JSON.parse(await readFile(vscodeWeb.pkgPath, 'utf8'));
	console.log(`vscode-web source: ${vscodeWeb.label} @ ${vscodeWebPkg.version}`);

	console.error('[build] resetDist');
	await resetDist();
	console.error('[build] copyStaticAssets');
	await copyStaticAssets(vscodeWeb.dir);

	console.log('Building local extensions:');
	const localExtensionRefs = await buildLocalExtensions();
	console.error('[build] local extensions done');

	console.log('Fetching Open VSX extensions:');
	const openvsxExtensionRefs = await fetchAndUnpackExtensions();
	console.error('[build] open vsx done');

	await writeProductJson(vscodeWebPkg.version, [...localExtensionRefs, ...openvsxExtensionRefs]);
	console.error('[build] product.json written');

	console.log('Build complete 🚀');
}

await main();
