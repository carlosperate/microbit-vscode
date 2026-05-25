import esbuild from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'extensions', 'workspace-storage');
const outDir = path.join(root, 'dist', 'extensions', 'microbit.workspace-storage');
const welcomeDir = path.join(root, 'welcome-workspace');

/**
 * Walk `welcome-workspace/` and return [{ path, contents }] entries. Returns []
 * if the directory is missing or empty. Dotfiles are skipped.
 *
 * TODO: If dotfiles are needed in the future, we should probably exclude
 * OS-generated ones like `.DS_Store` but not all dotfiles.
 *
 * Paths use forward slashes and are relative to `welcome-workspace/`. The
 * extension seeds these into `memfs:/welcome/<path>` at activation time.
 */
async function collectWelcomeFiles() {
	let topLevel;
	try {
		topLevel = await readdir(welcomeDir, { withFileTypes: true });
	} catch (e) {
		if (e.code === 'ENOENT') return [];
		throw e;
	}
	const out = [];
	async function walk(dirAbs, relPrefix) {
		const entries = await readdir(dirAbs, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const abs = path.join(dirAbs, entry.name);
			const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(abs, rel);
			} else if (entry.isFile()) {
				const contents = await readFile(abs, 'utf8');
				out.push({ path: rel, contents });
			}
		}
	}
	// Seed `walk` with the already-read top-level dirents so we don't re-read.
	for (const entry of topLevel) {
		if (entry.name.startsWith('.')) continue;
		const abs = path.join(welcomeDir, entry.name);
		if (entry.isDirectory()) {
			await walk(abs, entry.name);
		} else if (entry.isFile()) {
			const contents = await readFile(abs, 'utf8');
			out.push({ path: entry.name, contents });
		}
	}
	return out;
}

export async function buildWorkspaceStorageExtension() {
	await mkdir(path.join(outDir, 'dist'), { recursive: true });
	const welcomeFiles = await collectWelcomeFiles();
	await esbuild.build({
		entryPoints: [path.join(srcDir, 'src', 'extension.ts')],
		bundle: true,
		format: 'cjs',
		platform: 'browser',
		target: 'es2020',
		external: ['vscode'],
		outfile: path.join(outDir, 'dist', 'extension.js'),
		sourcemap: true,
		logLevel: 'warning',
		define: {
			__WELCOME_FILES__: JSON.stringify(welcomeFiles),
		},
	});
	await copyFile(path.join(srcDir, 'package.json'), path.join(outDir, 'package.json'));
	// Empty NLS stub so VS Code's localized-strings probe doesn't 404.
	await writeFile(path.join(outDir, 'package.nls.json'), '{}\n');
	return { scheme: 'http', path: '/extensions/microbit.workspace-storage' };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	buildWorkspaceStorageExtension().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
