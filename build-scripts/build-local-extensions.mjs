import esbuild from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcExtensionsDir = path.join(root, 'src', 'extensions');
const distExtensionsDir = path.join(root, 'dist', 'extensions');

// Local extensions authored and built in this repository. Each owns an
// `esbuild.config.mjs` that exports `getBuildOptions()` or can build itself.
const localExtensions = [
	path.join(srcExtensionsDir, 'workspace-storage'),
	path.join(srcExtensionsDir, 'sidebar-actions'),
];

/**
 * Build a local extension from its source directory.
 *
 * Modifies the extension's esbuild options and package.json to output to
 * `dist/extensions/<publisher>.<name>/`.
 */
async function buildLocalExtension(srcDir) {
	const pkg = JSON.parse(await readFile(path.join(srcDir, 'package.json'), 'utf8'));
	const distId = `${pkg.publisher}.${pkg.name}`;
	const outDir = path.join(distExtensionsDir, distId);
	const updatedOutFileRelative = "./dist/extension.js";

	const { getBuildOptions } = await import(
		pathToFileURL(path.join(srcDir, 'esbuild.config.mjs')).href
	);
	const options = await getBuildOptions();
	options.outfile = path.join(outDir, updatedOutFileRelative);

	await mkdir(path.dirname(options.outfile), { recursive: true });
	await esbuild.build(options);

	const packageJsonOut = { ...pkg, browser: updatedOutFileRelative };
	await writeFile(path.join(outDir, 'package.json'), JSON.stringify(packageJsonOut, null, '\t') + '\n');

	// Empty NLS stub so VS Code's localized-strings probe doesn't 404.
	await writeFile(path.join(outDir, 'package.nls.json'), '{}\n');

	return {
		ref: { scheme: 'http', path: `/extensions/${distId}` },
		id: distId,
		// A proposed API is refused unless the product allows it for this id, and an
		// allow-list kept by hand goes stale silently: the extension fails to activate.
		proposals: pkg.enabledApiProposals ?? [],
	};
}

/**
 * Build every local extension and return their `additionalBuiltinExtensions`
 * refs, mirroring fetch-openvsx's return shape, plus the API proposals each
 * manifest asks for, keyed by extension id.
 */
export async function buildLocalExtensions() {
	const refs = [];
	const proposals = {};
	for (const srcDir of localExtensions) {
		console.log(`\tBuilding  ${path.relative('.', srcDir)}`);
		const built = await buildLocalExtension(srcDir);
		refs.push(built.ref);
		if (built.proposals.length > 0) proposals[built.id] = built.proposals;
	}
	return { refs, proposals };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	buildLocalExtensions().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
