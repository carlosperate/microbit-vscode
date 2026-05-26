import esbuild from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The welcome workspace is a set of files to be present as the default
// workspace and is located at the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
const welcomeDir = path.resolve(here, '..', '..', '..', 'welcome-workspace');

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

/**
 * Full esbuild options for this extension.
 * The project extensions orchestrator imports these options and overrides
 * what it needs to pack the extension for the VS Code deployment.
 *
 * Async because it inlines the repo-root `welcome-workspace/` manifest as the
 * `__WELCOME_FILES__` constant read by extension.ts (this extension seeds
 * `memfs:/welcome`).
 */
export async function getBuildOptions() {
	return {
		entryPoints: [path.join(here, 'src', 'extension.ts')],
		bundle: true,
		format: 'cjs',
		platform: 'browser',
		target: 'es2020',
		external: ['vscode'],
		outfile: path.join(here, 'dist', 'extension.js'),
		sourcemap: true,
		logLevel: 'warning',
		define: { __WELCOME_FILES__: JSON.stringify(await collectWelcomeFiles()) },
	};
}

// Built standalone (`node esbuild.config.mjs`): bundle into the extension's own
// `dist/`. The package.json next to this file already points `browser` at it,
// so the extension folder is directly loadable after a standalone build.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	getBuildOptions()
		.then((options) => esbuild.build(options))
		.catch((e) => {
			console.error(e);
			process.exit(1);
		});
}
