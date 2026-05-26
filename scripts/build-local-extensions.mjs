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

	return { scheme: 'http', path: `/extensions/${distId}` };
}

/**
 * Build every local extension and return their `additionalBuiltinExtensions`
 * refs (one entry per extension), mirroring fetch-openvsx's return shape.
 */
export async function buildLocalExtensions() {
	const refs = [];
	for (const srcDir of localExtensions) {
		refs.push(await buildLocalExtension(srcDir));
	}
	return refs;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	buildLocalExtensions().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
